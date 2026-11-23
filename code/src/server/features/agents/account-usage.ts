import type { Database } from "bun:sqlite";
import type {
  AccountUsageDay,
  AccountUsageReport,
  AccountUsageTotals,
  AccountUsageWindow,
} from "../../../shared/accounts";
import { estimateCostUsd } from "../../db/pricing";
import { AccountError } from "./accounts-ops";
import { getAccount } from "./accounts-repo";

interface UsageBucketRow {
  day: string;
  agent: string;
  model: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost: number | null;
  reported_count: number;
  events: number;
}

interface SnapshotWindowRow {
  window: string;
  used_percent: number | null;
  resets_at: number | null;
}

const HOUR_MS = 60 * 60_000;
const WINDOW_DURATION_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
  primary: 5 * HOUR_MS,
  secondary: 7 * 24 * HOUR_MS,
};

function emptyTotals(): AccountUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    estimatedCostUsd: 0,
    unpricedEvents: 0,
    events: 0,
  };
}

function accumulate(db: Database, rows: UsageBucketRow[]): AccountUsageTotals {
  const out = emptyTotals();
  let allReported = rows.length > 0;
  let reportedSum = 0;
  for (const r of rows) {
    out.inputTokens += r.input;
    out.outputTokens += r.output;
    out.cacheReadTokens += r.cache_read;
    out.cacheWriteTokens += r.cache_write;
    out.reasoningTokens += r.reasoning;
    out.events += r.events;
    if (r.reported_count === r.events && r.cost !== null) {
      reportedSum += r.cost;
      out.estimatedCostUsd += r.cost;
    } else {
      allReported = false;
      const est = estimateCostUsd(db, r.agent, r.model, {
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
      });
      if (est === null) out.unpricedEvents += r.events;
      else out.estimatedCostUsd += est;
    }
  }
  out.reportedCostUsd = allReported ? reportedSum : null;
  return out;
}

function queryBuckets(
  db: Database,
  accountId: string,
  sinceMs: number,
  untilMs?: number,
): UsageBucketRow[] {
  const upper = untilMs === undefined ? "" : "AND ts <= ?";
  const args: Array<string | number> =
    untilMs === undefined ? [accountId, sinceMs] : [accountId, sinceMs, untilMs];
  return db
    .query<UsageBucketRow, Array<string | number>>(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
              agent, gen_ai_request_model AS model,
              COALESCE(sum(gen_ai_usage_input_tokens), 0) AS input,
              COALESCE(sum(gen_ai_usage_output_tokens), 0) AS output,
              COALESCE(sum(cache_read_tokens), 0) AS cache_read,
              COALESCE(sum(cache_write_tokens), 0) AS cache_write,
              COALESCE(sum(reasoning_tokens), 0) AS reasoning,
              sum(reported_cost_usd) AS cost,
              count(reported_cost_usd) AS reported_count,
              count(*) AS events
       FROM events
       WHERE kind = 'usage'
         AND COALESCE(account_id, 'default:' || agent) = ?
         AND ts >= ? ${upper}
       GROUP BY day, agent, gen_ai_request_model
       ORDER BY day DESC, agent, gen_ai_request_model`,
    )
    .all(...args);
}

function latestWindows(db: Database, accountId: string): SnapshotWindowRow[] {
  const legacyProvider = accountId.startsWith("default:")
    ? accountId.slice("default:".length)
    : null;
  return db
    .query<SnapshotWindowRow, [string, string | null]>(
      `SELECT window, used_percent, resets_at FROM (
         SELECT window, used_percent, resets_at,
                row_number() OVER (PARTITION BY window ORDER BY ts DESC, rowid DESC) AS rn
         FROM quota_snapshots
         WHERE account_id = ? OR (account_id IS NULL AND provider = ?)
       ) WHERE rn = 1 ORDER BY window`,
    )
    .all(accountId, legacyProvider);
}

export function accountUsageReport(
  db: Database,
  runtime: string,
  accountId: string,
  sinceMs = 0,
  now: number = Date.now(),
): AccountUsageReport {
  const existing = getAccount(db, accountId);
  if (existing ? existing.runtime !== runtime : accountId !== `default:${runtime}`) {
    throw new AccountError(404, "account not found");
  }
  const rows = queryBuckets(db, accountId, sinceMs);
  const byDayMap = new Map<string, UsageBucketRow[]>();
  for (const r of rows) {
    const list = byDayMap.get(r.day) ?? [];
    list.push(r);
    byDayMap.set(r.day, list);
  }
  const byDay: AccountUsageDay[] = [...byDayMap.entries()].map(([day, list]) => ({
    day,
    ...accumulate(db, list),
  }));
  const windows: AccountUsageWindow[] = latestWindows(db, accountId).map((w) => {
    const span = WINDOW_DURATION_MS[w.window] ?? 24 * HOUR_MS;
    const end = w.resets_at !== null && w.resets_at > now ? w.resets_at : now;
    const start = Math.max(sinceMs, end - span);
    const slice = queryBuckets(db, accountId, start, end);
    return {
      window: w.window,
      usedPercent: w.resets_at !== null && w.resets_at <= now ? null : w.used_percent,
      resetsAt: w.resets_at,
      ...accumulate(db, slice),
    };
  });
  return { accountId, runtime, totals: accumulate(db, rows), byDay, windows };
}
