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
// Codex is probed every few minutes; Claude only reports inside live runs, so its readings last longer.
const TTL_MS: Readonly<Record<string, number>> = { codex: 10 * MINUTE };
const DEFAULT_TTL_MS = 60 * MINUTE;
const RETENTION_MS = 30 * 24 * 60 * MINUTE;

// Rows written before accounts existed have no account_id and belong to the provider's default account.
const accountSql = (alias = ""): string =>
  `COALESCE(${alias}account_id, 'default:' || ${alias}provider)`;

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
): (SnapshotRow & { id: number }) | null {
  return db
    .query<SnapshotRow & { id: number }, [string, string]>(
      `SELECT rowid AS id, provider, ${accountSql()} AS account_id, window, used_percent, resets_at, source, ts
       FROM quota_snapshots WHERE ${accountSql()} = ? AND window = ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(accountId, window);
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

// One row per account and window. A reading past its TTL, or whose window has reset, says nothing
// about current usage and reads as unknown.
export function latestQuota(
  db: Database,
  accountId?: string,
  now: number = Date.now(),
): QuotaView[] {
  const rows = db
    .query<SnapshotRow, [string | null, string | null]>(
      `SELECT provider, ${accountSql()} AS account_id, window, used_percent, resets_at, source, ts
       FROM quota_snapshots q
       WHERE rowid = (SELECT rowid FROM quota_snapshots
                      WHERE ${accountSql()} = ${accountSql("q.")}
                        AND window = q.window
                      ORDER BY ts DESC, rowid DESC LIMIT 1)
         AND (? IS NULL OR ${accountSql("q.")} = ?)
       ORDER BY provider, account_id, window`,
    )
    .all(accountId ?? null, accountId ?? null);
  const views: QuotaView[] = rows.map((r) => ({
    provider: r.provider,
    accountId: r.account_id,
    window: r.window,
    usedPercent:
      (r.resets_at !== null && r.resets_at <= now) ||
      now - r.ts > (TTL_MS[r.provider] ?? DEFAULT_TTL_MS)
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
