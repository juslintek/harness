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

function accountQuotaViews(
  quota: QuotaView[],
  runtime: string,
  accountId: string,
  now: number,
): QuotaView[] {
  const provider = QUOTA_PROVIDER[runtime];
  return quota.filter(
    (q) =>
      q.provider === provider &&
      q.accountId === accountId &&
      q.usedPercent !== null &&
      (q.resetsAt === null || q.resetsAt > now),
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

export interface RejectedAccount {
  id: string;
  runtime: string;
  rejectedBy: string;
}

function rejectReason(
  acct: PoolAccount,
  engine: Engine,
  used: number[],
  ctx: AccountContext,
): string | null {
  if (engine.accountId != null && acct.id !== engine.accountId) return "pinned_account";
  if (!USABLE_STATES.has(acct.state)) return "state";
  if (acct.exhaustedUntil !== null && acct.exhaustedUntil > ctx.now) return "exhausted_until";
  if ((ctx.live.get(acct.id) ?? 0) >= acct.maxConcurrent) return "max_concurrent";
  if (isExcluded(engine, acct.id, ctx.exclude)) return "excluded";
  if (used.some((u) => u >= 100)) return "quota_full";
  return null;
}

function evaluateAccount(
  acct: PoolAccount,
  engine: Engine,
  quota: QuotaView[],
  ctx: AccountContext,
  explicit: boolean,
): { candidate: AccountCandidate } | { rejected: RejectedAccount } {
  const views = accountQuotaViews(quota, engine.runtime, acct.id, ctx.now);
  const used = views.map((v) => v.usedPercent as number);
  const rejectedBy = rejectReason(acct, engine, used, ctx);
  if (rejectedBy !== null) {
    return { rejected: { id: acct.id, runtime: engine.runtime, rejectedBy } };
  }
  const resets = views.flatMap((v) =>
    v.resetsAt !== null && v.resetsAt > ctx.now ? [v.resetsAt] : [],
  );
  return {
    candidate: {
      id: acct.id,
      runtime: engine.runtime,
      headroom: used.length === 0 ? null : 1 - Math.max(...used) / 100,
      lastUsedAt: ctx.lastUsed.get(acct.id) ?? 0,
      priority: acct.priority,
      createdAt: acct.createdAt,
      earliestResetAt: resets.length === 0 ? null : Math.min(...resets),
      explicit,
    },
  };
}

function runtimePool(db: Database, runtime: string): { pool: PoolAccount[]; explicit: boolean } {
  const real = listAccounts(db, runtime);
  if (real.length > 0) return { pool: real, explicit: true };
  return {
    explicit: false,
    pool: [
      {
        id: `default:${runtime}`,
        state: "unknown",
        maxConcurrent: runtime === "codex" ? 1 : 2,
        priority: 0,
        createdAt: 0,
        exhaustedUntil: null,
      },
    ],
  };
}

export function evaluateAccounts(
  db: Database,
  engine: Engine,
  quota: QuotaView[],
  ctx: AccountContext,
): { eligible: AccountCandidate[]; rejected: RejectedAccount[] } {
  const { pool, explicit } = runtimePool(db, engine.runtime);
  const eligible: AccountCandidate[] = [];
  const rejected: RejectedAccount[] = [];
  for (const acct of pool) {
    const res = evaluateAccount(acct, engine, quota, ctx, explicit);
    if ("candidate" in res) eligible.push(res.candidate);
    else rejected.push(res.rejected);
  }
  return { eligible, rejected };
}

export function eligibleAccounts(
  db: Database,
  engine: Engine,
  quota: QuotaView[],
  ctx: AccountContext,
): AccountCandidate[] {
  return evaluateAccounts(db, engine, quota, ctx).eligible;
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

const MIN_PARK_MS = 60_000;
const FALLBACK_RETRY_MS = 15 * 60_000;

function accountRecoveryAt(
  acct: PoolAccount,
  runtime: string,
  quota: QuotaView[],
  now: number,
): number | null {
  const views = accountQuotaViews(quota, runtime, acct.id, now);
  const full = views.filter((v) => v.usedPercent !== null && v.usedPercent >= 100);
  const byCooldown = acct.exhaustedUntil !== null && acct.exhaustedUntil > now;
  if (!byCooldown && full.length === 0) return null;
  const fullResets = full.flatMap((v) =>
    v.resetsAt !== null && v.resetsAt > now ? [v.resetsAt] : [],
  );
  const windowUntil = fullResets.length > 0 ? Math.max(...fullResets) : 0;
  const until = Math.max(windowUntil, byCooldown ? (acct.exhaustedUntil as number) : 0);
  return until > now ? until : now + FALLBACK_RETRY_MS;
}

function runtimeRecoveries(
  db: Database,
  runtime: string,
  quota: QuotaView[],
  now: number,
): number[] | null {
  const out: number[] = [];
  for (const acct of runtimePool(db, runtime).pool) {
    if (!USABLE_STATES.has(acct.state)) continue;
    const at = accountRecoveryAt(acct, runtime, quota, now);
    if (at === null) return null;
    out.push(at);
  }
  return out;
}

// Non-null only when every usable account across the candidate engines is exhausted.
export function poolExhaustedRetryAt(
  db: Database,
  engines: Engine[],
  quota: QuotaView[],
  now: number = Date.now(),
): number | null {
  const runtimes = [...new Set(engines.map((e) => e.runtime))];
  const recoveries: number[] = [];
  for (const runtime of runtimes) {
    const times = runtimeRecoveries(db, runtime, quota, now);
    if (times === null) return null;
    recoveries.push(...times);
  }
  if (recoveries.length === 0) return null;
  return Math.max(now + MIN_PARK_MS, Math.min(...recoveries));
}
