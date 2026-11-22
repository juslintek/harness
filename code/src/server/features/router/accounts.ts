import type { Database } from "bun:sqlite";
import { type Engine, QUOTA_PROVIDER } from "../../../shared/router";
import { listAccounts } from "../agents/api";
import { liveRuns } from "../runtimes/api";
import type { QuotaView } from "../usage/api";

const USABLE_STATES = new Set(["active", "unknown"]);

interface AccountCandidate {
  id: string;
  runtime: string;
  headroom: number | null;
  lastUsedAt: number;
  explicit: boolean;
}

interface AccountContext {
  now: number;
  live: Map<string, number>;
  lastUsed: Map<string, number>;
  exclude?: Engine[] | undefined;
}

function liveCountsByAccount(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of liveRuns(db)) {
    const key = run.accountId ?? `default:${run.agentId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function lastUsedByAccount(db: Database): Map<string, number> {
  const rows = db
    .query<{ acct: string; ts: number }, []>(
      "SELECT COALESCE(account_id, 'default:' || agent_id) AS acct, max(created_at) AS ts FROM runs GROUP BY acct",
    )
    .all();
  return new Map(rows.map((r) => [r.acct, r.ts]));
}

function accountWindows(quota: QuotaView[], runtime: string, accountId: string): number[] {
  const provider = QUOTA_PROVIDER[runtime];
  return quota.flatMap((q) =>
    q.provider === provider && q.accountId === accountId && q.usedPercent !== null
      ? [q.usedPercent]
      : [],
  );
}

function isExcluded(engine: Engine, accountId: string, exclude: Engine[] | undefined): boolean {
  for (const x of exclude ?? []) {
    if (x.runtime !== engine.runtime || x.model !== engine.model) continue;
    if (x.accountId == null || x.accountId === accountId) return true;
  }
  return false;
}

export function accountContext(
  db: Database,
  exclude?: Engine[] | undefined,
  now: number = Date.now(),
): AccountContext {
  return {
    now,
    live: liveCountsByAccount(db),
    lastUsed: lastUsedByAccount(db),
    exclude,
  };
}

interface PoolAccount {
  id: string;
  state: string;
  maxConcurrent: number;
  exhaustedUntil: number | null;
}

function toCandidate(
  acct: PoolAccount,
  engine: Engine,
  quota: QuotaView[],
  ctx: AccountContext,
  explicit: boolean,
): AccountCandidate | null {
  if (engine.accountId != null && acct.id !== engine.accountId) return null;
  if (!USABLE_STATES.has(acct.state)) return null;
  if (acct.exhaustedUntil !== null && acct.exhaustedUntil > ctx.now) return null;
  if ((ctx.live.get(acct.id) ?? 0) >= acct.maxConcurrent) return null;
  if (isExcluded(engine, acct.id, ctx.exclude)) return null;
  const used = accountWindows(quota, engine.runtime, acct.id);
  if (used.some((u) => u >= 100)) return null;
  return {
    id: acct.id,
    runtime: engine.runtime,
    headroom: used.length === 0 ? null : 1 - Math.max(...used) / 100,
    lastUsedAt: ctx.lastUsed.get(acct.id) ?? 0,
    explicit,
  };
}

export function eligibleAccounts(
  db: Database,
  engine: Engine,
  quota: QuotaView[],
  ctx: AccountContext,
): AccountCandidate[] {
  const real = listAccounts(db, engine.runtime);
  const explicit = real.length > 0;
  const pool: PoolAccount[] = explicit
    ? real
    : [
        {
          id: `default:${engine.runtime}`,
          state: "unknown",
          maxConcurrent: engine.runtime === "codex" ? 1 : 2,
          exhaustedUntil: null,
        },
      ];
  return pool.flatMap((acct) => {
    const candidate = toCandidate(acct, engine, quota, ctx, explicit);
    return candidate ? [candidate] : [];
  });
}

// Spread: pick the eligible account with the most headroom on its tightest window,
// breaking ties by least-recently-used and then account id for determinism.
export function pickBestAccount(candidates: AccountCandidate[]): AccountCandidate | null {
  const sorted = [...candidates].sort(
    (a, b) =>
      (b.headroom ?? 0.5) - (a.headroom ?? 0.5) ||
      a.lastUsedAt - b.lastUsedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return sorted[0] ?? null;
}

export function pickAccountForRuntime(
  db: Database,
  runtime: string,
  quota: QuotaView[],
  now: number = Date.now(),
): string | null {
  const best = pickBestAccount(
    eligibleAccounts(db, { runtime, model: null }, quota, accountContext(db, undefined, now)),
  );
  return best?.explicit ? best.id : null;
}
