import type { Database } from "bun:sqlite";

export interface QuotaView {
  provider: string;
  accountId: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  source: string;
  ts: number;
}

export interface QuotaInput {
  provider: string;
  // Omitted means the default account of the provider, so old writers keep working.
  accountId?: string | undefined;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  source: string;
  // Observation time; the log line's own timestamp when ingesting history.
  ts?: number;
}

const PROVIDERS = ["claude", "codex", "agy"];

const MINUTE = 60_000;
// Codex readings come from its session logs, which the tailer reads every minute while Codex runs;
// Claude only reports inside live runs, so its readings last longer.
const TTL_MS: Readonly<Record<string, number>> = { codex: 10 * MINUTE };
const DEFAULT_TTL_MS = 60 * MINUTE;
const RETENTION_MS = 30 * 24 * 60 * MINUTE;

// Rows written before accounts existed have a NULL account_id and belong to the provider's default
// account. account_id is not wrapped in a function here, so the (account_id, window, ts) index stays usable.
function ofAccount(accountId: string): { sql: string; args: [string, string | null] } {
  const legacyProvider = accountId.startsWith("default:")
    ? accountId.slice("default:".length)
    : null;
  return {
    sql: "(account_id = ? OR (account_id IS NULL AND provider = ?))",
    args: [accountId, legacyProvider],
  };
}

interface SnapshotRow {
  provider: string;
  account_id: string;
  window: string;
  used_percent: number | null;
  resets_at: number | null;
  source: string;
  ts: number;
}

function latest(
  db: Database,
  accountId: string,
  window: string,
): { id: number; used_percent: number | null; resets_at: number | null; ts: number } | null {
  const match = ofAccount(accountId);
  return db
    .query<
      { id: number; used_percent: number | null; resets_at: number | null; ts: number },
      [string, string, string | null]
    >(
      `SELECT rowid AS id, used_percent, resets_at, ts FROM quota_snapshots
       WHERE window = ? AND ${match.sql} ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(window, ...match.args);
}

const accountOf = (s: QuotaInput): string => s.accountId ?? `default:${s.provider}`;

const listeners = new Set<(q: QuotaInput) => void>();

export function onQuotaRecorded(listener: (q: QuotaInput) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function insertSnapshot(db: Database, input: QuotaInput): void {
  const s = { ...input, accountId: accountOf(input) };
  db.query(
    "INSERT INTO quota_snapshots (id, provider, account_id, window, used_percent, resets_at, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    Bun.randomUUIDv7(),
    s.provider,
    s.accountId,
    s.window,
    s.usedPercent,
    s.resetsAt,
    s.source,
    s.ts ?? Date.now(),
  );
  for (const listener of listeners) {
    try {
      listener(s);
    } catch (err) {
      console.error("quota listener failed", err);
    }
  }
}

// Tailers see the same limits on every turn; keep one row per change. An unchanged reading still
// moves the row's ts forward, otherwise a steady value would age out of its TTL while it is current.
export function insertSnapshotIfChanged(db: Database, s: QuotaInput): void {
  const last = latest(db, accountOf(s), s.window);
  if (last && last.used_percent === s.usedPercent && last.resets_at === s.resetsAt) {
    const seen = s.ts ?? Date.now();
    if (seen > last.ts)
      db.run("UPDATE quota_snapshots SET ts = ? WHERE rowid = ?", [seen, last.id]);
    return;
  }
  insertSnapshot(db, s);
}

export function pruneQuota(db: Database, now: number = Date.now()): number {
  return db.run("DELETE FROM quota_snapshots WHERE ts < ?", [now - RETENTION_MS]).changes;
}

// One row per account and window. A reading whose window has reset says nothing about current usage
// and reads as unknown. So does a reading past its TTL, except a full window with a reset still ahead:
// nothing runs on a full account, so nothing would refresh it, and dropping it would let the router
// send a run there every TTL period until the reset.
export function latestQuota(
  db: Database,
  accountId?: string,
  now: number = Date.now(),
): QuotaView[] {
  const match = accountId === undefined ? null : ofAccount(accountId);
  const rows = db
    .query<SnapshotRow, Array<string | null>>(
      `SELECT provider, account_id, window, used_percent, resets_at, source, ts FROM (
         SELECT provider, COALESCE(account_id, 'default:' || provider) AS account_id, window,
                used_percent, resets_at, source, ts,
                row_number() OVER (
                  PARTITION BY COALESCE(account_id, 'default:' || provider), window
                  ORDER BY ts DESC, rowid DESC) AS rn
         FROM quota_snapshots ${match ? `WHERE ${match.sql}` : ""}
       ) WHERE rn = 1 ORDER BY provider, account_id, window`,
    )
    .all(...(match?.args ?? []));
  const views: QuotaView[] = rows.map((r) => ({
    provider: r.provider,
    accountId: r.account_id,
    window: r.window,
    usedPercent:
      r.resets_at !== null && r.resets_at <= now
        ? null
        : r.used_percent !== null && r.used_percent >= 100 && r.resets_at !== null
          ? r.used_percent
          : now - r.ts > (TTL_MS[r.provider] ?? DEFAULT_TTL_MS)
            ? null
            : r.used_percent,
    resetsAt: r.resets_at,
    source: r.source,
    ts: r.ts,
  }));
  if (accountId !== undefined) return views;
  for (const provider of PROVIDERS) {
    if (views.some((v) => v.provider === provider)) continue;
    views.push({
      provider,
      accountId: `default:${provider}`,
      window: "unknown",
      usedPercent: null,
      resetsAt: null,
      source: "unknown",
      ts: now,
    });
  }
  return views;
}
