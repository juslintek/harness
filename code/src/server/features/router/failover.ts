import type { Database } from "bun:sqlite";
import type { Engine } from "../../../shared/router";
import { contextForMember, effective } from "../policies/api";
import { getRun, killRun, liveRuns, type RunRow } from "../runtimes/api";
import { onQuotaRecorded } from "../usage/api";
import { type RouteDeps, routeOutcome } from "./candidates";
import { handoffSummary } from "./handoff";

export interface NextAttempt {
  engine: Engine;
  handoffId: string;
  summary: string;
  reuseWorktreeOf: string;
  decisionId?: string | null;
}

export type FailoverDecision =
  | { kind: "next"; attempt: NextAttempt }
  | { kind: "park"; retryAt: number }
  | { kind: "none" };

const MAX_ATTEMPTS = 3;

// Everything else that ends a run (user kill, halt, guard denial, approval timeout, spent budget) is a
// decision to stop, not a fault of the engine.
function failsOver(run: RunRow): boolean {
  if (run.state === "failed") return run.reason !== "budget_exhausted";
  return run.state === "killed" && run.reason === "quota_exhausted";
}

const isExhaustionStop = (run: RunRow): boolean =>
  run.reason === "rate_limited" || run.reason === "quota_exhausted";

function triedIn(db: Database, batchId: string): Engine[] {
  return db
    .query<{ agent_id: string; model: string | null; account_id: string }, [string, string]>(
      "SELECT agent_id, model, COALESCE(account_id, 'default:' || agent_id) AS account_id FROM runs WHERE batch_id = ? OR id = ?",
    )
    .all(batchId, batchId)
    .map((r) => ({ runtime: r.agent_id, model: r.model, accountId: r.account_id }));
}

// Two paths can end the same run (the quota watchdog and the run's own error); the unique handoff per
// failed run lets only one of them continue.
export async function nextAttemptOrPark(
  db: Database,
  endedRunId: string,
  deps?: RouteDeps,
  runtimeFilter?: (runtime: string) => boolean,
): Promise<FailoverDecision> {
  const run = getRun(db, endedRunId);
  if (!run?.memberId || !run.worktree || !failsOver(run) || run.attempt >= MAX_ATTEMPTS) {
    return { kind: "none" };
  }
  const ctx = contextForMember(db, run.memberId, run.taskId ?? undefined);
  if (!effective(db, ctx, "router.failover").value) return { kind: "none" };
  const batchId = run.batchId ?? run.id;
  const { choices, poolExhausted, decisionId } = await routeOutcome(
    db,
    { memberId: run.memberId, taskId: run.taskId, exclude: triedIn(db, batchId), runtimeFilter },
    deps,
  );
  // Same CLI + worktree gives the cleanest handoff, so try remaining accounts of the same engine first.
  const next =
    choices.find((c) => c.engine.runtime === run.agentId && c.engine.model === run.model) ??
    choices[0];
  if (!next) {
    if (poolExhausted !== null && isExhaustionStop(run)) {
      return { kind: "park", retryAt: poolExhausted.retryAt };
    }
    return { kind: "none" };
  }
  const summary = await handoffSummary(db, run);
  const handoffId = Bun.randomUUIDv7();
  const inserted = db.run(
    `INSERT INTO run_handoffs (id, batch_id, task_id, member_id, from_run_id, reason, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(from_run_id) DO NOTHING`,
    [
      handoffId,
      batchId,
      run.taskId,
      run.memberId,
      run.id,
      run.reason ?? run.state,
      summary,
      Date.now(),
    ],
  );
  if (inserted.changes === 0) return { kind: "none" };
  return {
    kind: "next",
    attempt: { engine: next.engine, handoffId, summary, reuseWorktreeOf: run.id, decisionId },
  };
}

export async function nextAttempt(
  db: Database,
  endedRunId: string,
  deps?: RouteDeps,
  runtimeFilter?: (runtime: string) => boolean,
): Promise<NextAttempt | null> {
  const res = await nextAttemptOrPark(db, endedRunId, deps, runtimeFilter);
  return res.kind === "next" ? res.attempt : null;
}

export function linkHandoff(db: Database, handoffId: string, toRunId: string): void {
  db.run("UPDATE run_handoffs SET to_run_id = ? WHERE id = ?", [toRunId, handoffId]);
}

// Every live run on the exhausted account stops at once; its own error path would only get there later.
// Other accounts of the same provider have their own windows and keep running.
// A snapshot read back from old logs can say 100% for a window that has long reset, so it is ignored.
export function startWatchdog(db: Database): () => void {
  return onQuotaRecorded((q) => {
    if (q.usedPercent === null || q.usedPercent < 100) return;
    if (q.resetsAt !== null && q.resetsAt <= Date.now()) return;
    const accountId = q.accountId ?? `default:${q.provider}`;
    for (const run of liveRuns(db)) {
      if (run.accountId === accountId) killRun(db, run.id, "quota_exhausted");
    }
  });
}
