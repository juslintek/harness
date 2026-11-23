import type { Database } from "bun:sqlite";
import type { AccountPolicy } from "../../../shared/policies";
import { type Engine, QUOTA_PROVIDER } from "../../../shared/router";
import { listAccounts } from "../agents/api";
import { liveRuns } from "../runtimes/api";
import type { QuotaView } from "../usage/api";

const USABLE_STATES = new Set(["active", "unknown"]);

export interface AccountCandidate {
  id: string;
  runtime: string;
  headroom: number | null;
  lastUsedAt: number;
  priority: number;
  createdAt: number;
  earliestResetAt: number | null;
  explicit: boolean;
}

export interface AccountContext {
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

function accountQuotaViews(quota: QuotaView[], runtime: string, accountId: string): QuotaView[] {
  const provider = QUOTA_PROVIDER[runtime];
  return quota.filter(
    (q) => q.provider === provider && q.accountId === accountId && q.usedPercent !== null,
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
  priority: number;
  createdAt: number;
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
  const views = accountQuotaViews(quota, engine.runtime, acct.id);
  const used = views.map((v) => v.usedPercent as number);
  if (used.some((u) => u >= 100)) return null;
  const resets = views.flatMap((v) =>
    v.resetsAt !== null && v.resetsAt > ctx.now ? [v.resetsAt] : [],
  );
  return {
    id: acct.id,
    runtime: engine.runtime,
    headroom: used.length === 0 ? null : 1 - Math.max(...used) / 100,
    lastUsedAt: ctx.lastUsed.get(acct.id) ?? 0,
    priority: acct.priority,
    createdAt: acct.createdAt,
    earliestResetAt: resets.length === 0 ? null : Math.min(...resets),
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
          priority: 0,
          createdAt: 0,
          exhaustedUntil: null,
        },
      ];
  return pool.flatMap((acct) => {
    const candidate = toCandidate(acct, engine, quota, ctx, explicit);
    return candidate ? [candidate] : [];
  });
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareSpread(a: AccountCandidate, b: AccountCandidate): number {
  return (
    (b.headroom ?? 0.5) - (a.headroom ?? 0.5) || a.lastUsedAt - b.lastUsedAt || cmpId(a.id, b.id)
  );
}

// Spread: most headroom on tightest window, LRU tie-break.
// Drain: ascending priority, then creation order so equal-priority accounts drain in turn instead of alternating.
// Expiring: soonest active window reset among accounts with headroom; accounts without a known reset sort last.
export function pickBestAccount(
  candidates: AccountCandidate[],
  policy: AccountPolicy = "spread",
): AccountCandidate | null {
  const sorted = [...candidates].sort((a, b) => {
    if (policy === "drain") {
      return a.priority - b.priority || a.createdAt - b.createdAt || cmpId(a.id, b.id);
    }
    if (policy === "expiring") {
      const ra = a.earliestResetAt ?? Number.POSITIVE_INFINITY;
      const rb = b.earliestResetAt ?? Number.POSITIVE_INFINITY;
      return ra - rb || compareSpread(a, b);
    }
    return compareSpread(a, b);
  });
  return sorted[0] ?? null;
}

export function pickAccountForRuntime(
  db: Database,
  runtime: string,
  quota: QuotaView[],
  now: number = Date.now(),
  policy: AccountPolicy = "spread",
): string | null {
  const best = pickBestAccount(
    eligibleAccounts(db, { runtime, model: null }, quota, accountContext(db, undefined, now)),
    policy,
  );
  return best?.explicit ? best.id : null;
}
