import type { Database } from "bun:sqlite";
import type { MemberReport } from "../../../shared/tracking";
import { estimateCostUsd } from "../router/api";
import { runTimes } from "./time";

interface MemberRow {
  id: string;
  handle: string;
  agent_id: string | null;
}

interface UsageRow {
  agent: string | null;
  model: string | null;
  input: number;
  output: number;
  cache_read: number;
  cost: number | null;
}

// Events without a reported cost are priced from the registry; those it cannot price stay unpriced.
function usageOf(
  db: Database,
  memberId: string,
  sinceMs: number,
): Pick<
  MemberReport,
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "costUsd"
  | "costEstimated"
  | "unpricedEvents"
> {
  const rows = db
    .query<UsageRow, [string, number]>(
      `SELECT e.agent, e.gen_ai_request_model AS model,
         COALESCE(e.gen_ai_usage_input_tokens, 0) AS input,
         COALESCE(e.gen_ai_usage_output_tokens, 0) AS output,
         COALESCE(e.cache_read_tokens, 0) AS cache_read, e.reported_cost_usd AS cost
       FROM events e JOIN runs r ON r.id = e.run_id
       WHERE e.kind = 'usage' AND r.member_id = ? AND r.started_at >= ?`,
    )
    .all(memberId, sinceMs);
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    costEstimated: false,
    unpricedEvents: 0,
  };
  for (const r of rows) {
    total.inputTokens += r.input;
    total.outputTokens += r.output;
    total.cacheReadTokens += r.cache_read;
    const cost =
      r.cost ??
      (r.agent
        ? estimateCostUsd(db, r.agent, r.model, {
            input: r.input,
            output: r.output,
            cacheRead: r.cache_read,
          })
        : null);
    if (cost === null) total.unpricedEvents += 1;
    else total.costUsd += cost;
    if (r.cost === null && cost !== null) total.costEstimated = true;
  }
  return total;
}

function estimatedMinutes(db: Database, memberId: string, sinceMs: number): [number, number] {
  const rows = db
    .query<{ kind: string; minutes: number }, [string, number]>(
      `SELECT e.kind, e.minutes FROM task_estimates e JOIN tasks t ON t.id = e.task_id
       WHERE t.status = 'done' AND t.assignee_id = ? AND t.updated_at >= ?
         AND e.rowid = (SELECT x.rowid FROM task_estimates x WHERE x.task_id = e.task_id AND x.kind = e.kind
                        ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)`,
    )
    .all(memberId, sinceMs);
  const sum = (kind: string): number =>
    rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.minutes, 0);
  return [sum("planner"), sum("reviewer")];
}

function counts(db: Database, memberId: string, sinceMs: number): Record<string, number> {
  const row = db
    .query<{ runs: number; completed: number; done: number }, [string, number, string, number]>(
      `SELECT (SELECT count(*) FROM runs WHERE member_id = ?1 AND started_at >= ?2) AS runs,
              (SELECT count(*) FROM runs WHERE member_id = ?1 AND started_at >= ?2 AND state = 'completed') AS completed,
              (SELECT count(*) FROM tasks WHERE assignee_id = ?3 AND status = 'done' AND updated_at >= ?4) AS done`,
    )
    .get(memberId, sinceMs, memberId, sinceMs);
  return { runs: row?.runs ?? 0, completed: row?.completed ?? 0, done: row?.done ?? 0 };
}

function toolsOf(db: Database, memberId: string, sinceMs: number): MemberReport["tools"] {
  return db
    .query<{ name: string; count: number }, [string, number]>(
      `SELECT e.gen_ai_tool_name AS name, count(*) AS count
       FROM events e JOIN runs r ON r.id = e.run_id
       WHERE e.kind = 'tool_call' AND e.gen_ai_tool_name IS NOT NULL
         AND r.member_id = ? AND r.started_at >= ?
       GROUP BY name ORDER BY count DESC, name LIMIT 5`,
    )
    .all(memberId, sinceMs);
}

function stackOf(db: Database, memberId: string, sinceMs: number): string[] {
  return db
    .query<{ item: string }, [string, number]>(
      `SELECT DISTINCT s.item FROM run_stack s JOIN runs r ON r.id = s.run_id
       WHERE r.member_id = ? AND r.started_at >= ? ORDER BY s.item`,
    )
    .all(memberId, sinceMs)
    .map((r) => r.item);
}

export function memberReport(db: Database, orgId: string, sinceMs: number): MemberReport[] {
  const members = db
    .query<MemberRow, [string]>(
      "SELECT id, handle, agent_id FROM members WHERE org_id = ? ORDER BY handle",
    )
    .all(orgId);
  const times = runTimes(db, { orgId, sinceMs });
  return members.map((m) => {
    const mine = times.filter((t) => t.memberId === m.id);
    const sum = (key: "wallMs" | "activeMs" | "waitingMs"): number =>
      mine.reduce((a, t) => a + t[key], 0);
    const c = counts(db, m.id, sinceMs);
    const [plannerMinutes, reviewerMinutes] = estimatedMinutes(db, m.id, sinceMs);
    return {
      memberId: m.id,
      handle: m.handle,
      runs: c.runs ?? 0,
      completed: c.completed ?? 0,
      ...usageOf(db, m.id, sinceMs),
      wallMs: sum("wallMs"),
      activeMs: sum("activeMs"),
      waitingMs: sum("waitingMs"),
      plannerMinutes,
      reviewerMinutes,
      tasksDone: c.done ?? 0,
      tools: toolsOf(db, m.id, sinceMs),
      stack: stackOf(db, m.id, sinceMs),
    };
  });
}
