import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvent, type NewEvent } from "../logs/api";
import {
  insertSnapshot,
  latestQuota,
  type QuotaInput,
  type QuotaView as QuotaViewRow,
} from "./quota";
import { type TailSource as TailSourceRow, tailSources } from "./tail";

export interface UsageRecord {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number | null;
  source: "acp" | "agy" | "api" | "tail";
}

export type TailSource = TailSourceRow;
export type QuotaView = QuotaViewRow;

export interface UsageSummaryRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedCostUsd: number | null;
  events: number;
}

export function recordUsage(
  db: Database,
  run: { id: string; agent: string; conversationId?: string },
  records: UsageRecord[],
): void {
  // Turns arrive in separate calls; continue numbering so dedupe keys never collide.
  const base =
    db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM events WHERE run_id = ? AND kind = 'usage' AND dedupe_key LIKE 'run:%'",
      )
      .get(run.id)?.n ?? 0;
  records.forEach((r, i) => {
    const event: NewEvent = {
      kind: "usage",
      runId: run.id,
      agent: run.agent,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      operation: "chat",
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      reasoningTokens: r.reasoningTokens,
      source: r.source,
      dedupeKey: `run:${run.id}:${base + i}`,
      ...(r.model === null ? {} : { model: r.model }),
      ...(r.reportedCostUsd === null ? {} : { reportedCostUsd: r.reportedCostUsd }),
    };
    appendEvent(db, event);
  });
}

// usedPercent is 0..100; callers holding a 0..1 fraction multiply first.
export function recordQuota(db: Database, s: QuotaInput): void {
  insertSnapshot(db, s);
}

export function defaultTailSources(harnessWorktrees?: string): TailSource[] {
  return [
    {
      name: "claude",
      glob: "*/*.jsonl",
      root: join(homedir(), ".claude", "projects"),
      ...(harnessWorktrees === undefined ? {} : { excludeCwdUnder: harnessWorktrees }),
    },
    { name: "codex", glob: "**/rollout-*.jsonl", root: join(homedir(), ".codex", "sessions") },
  ];
}

export function tailOnce(
  db: Database,
  sources: TailSource[] = defaultTailSources(),
): Promise<number> {
  return tailSources(db, sources);
}

export function startTailers(
  db: Database,
  intervalMs = 60000,
  sources: TailSource[] = defaultTailSources(),
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tailOnce(db, sources)
      .catch((err: unknown) => console.error("usage tail failed", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}

// Codex limits come from the tailer's snapshots; no provider is probed live yet.
export function probeQuota(db: Database): Promise<QuotaView[]> {
  return Promise.resolve(latestQuota(db));
}

const GROUP_COLUMN = { agent: "agent", model: "gen_ai_request_model", run: "run_id" } as const;

interface SummaryDbRow {
  key: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  events: number;
}

export function usageSummary(
  db: Database,
  by: "agent" | "model" | "run",
  sinceMs: number,
): UsageSummaryRow[] {
  const col = GROUP_COLUMN[by];
  const rows = db
    .query<SummaryDbRow, [number]>(
      `SELECT ${col} AS key,
         COALESCE(sum(gen_ai_usage_input_tokens), 0) AS input,
         COALESCE(sum(gen_ai_usage_output_tokens), 0) AS output,
         COALESCE(sum(cache_read_tokens), 0) AS cache_read,
         COALESCE(sum(cache_write_tokens), 0) AS cache_write,
         CASE WHEN count(reported_cost_usd) = count(*) THEN sum(reported_cost_usd) END AS cost,
         count(*) AS events
       FROM events WHERE kind = 'usage' AND ts >= ?
       GROUP BY ${col} ORDER BY ${col}`,
    )
    .all(sinceMs);
  return rows.map((r) => ({
    key: r.key ?? "unknown",
    inputTokens: r.input,
    outputTokens: r.output,
    cacheReadTokens: r.cache_read,
    cacheWriteTokens: r.cache_write,
    reportedCostUsd: r.cost,
    events: r.events,
  }));
}
