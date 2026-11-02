import type { Database } from "bun:sqlite";

export interface QuotaView {
  provider: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  source: string;
  ts: number;
}

export interface QuotaInput {
  provider: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  source: string;
  // Observation time; the log line's own timestamp when ingesting history.
  ts?: number;
}

const PROVIDERS = ["claude", "codex", "agy"];

interface SnapshotRow {
  provider: string;
  window: string;
  used_percent: number | null;
  resets_at: number | null;
  source: string;
  ts: number;
}

function latest(db: Database, provider: string, window: string): SnapshotRow | null {
  return db
    .query<SnapshotRow, [string, string]>(
      "SELECT provider, window, used_percent, resets_at, source, ts FROM quota_snapshots WHERE provider = ? AND window = ? ORDER BY ts DESC, rowid DESC LIMIT 1",
    )
    .get(provider, window);
}

export function insertSnapshot(db: Database, s: QuotaInput): void {
  db.query(
    "INSERT INTO quota_snapshots (id, provider, window, used_percent, resets_at, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    Bun.randomUUIDv7(),
    s.provider,
    s.window,
    s.usedPercent,
    s.resetsAt,
    s.source,
    s.ts ?? Date.now(),
  );
}

// Tailers see the same limits on every turn; keep one row per change.
export function insertSnapshotIfChanged(db: Database, s: QuotaInput): void {
  const last = latest(db, s.provider, s.window);
  if (last && last.used_percent === s.usedPercent && last.resets_at === s.resetsAt) return;
  insertSnapshot(db, s);
}

export function latestQuota(db: Database): QuotaView[] {
  const rows = db
    .query<SnapshotRow, []>(
      `SELECT provider, window, used_percent, resets_at, source, ts FROM quota_snapshots q
       WHERE rowid = (SELECT rowid FROM quota_snapshots
                      WHERE provider = q.provider AND window = q.window
                      ORDER BY ts DESC, rowid DESC LIMIT 1)
       ORDER BY provider, window`,
    )
    .all();
  const now = Date.now();
  const views: QuotaView[] = rows.map((r) => ({
    provider: r.provider,
    window: r.window,
    // A window that has already reset says nothing about current usage.
    usedPercent: r.resets_at !== null && r.resets_at <= now ? null : r.used_percent,
    resetsAt: r.resets_at,
    source: r.source,
    ts: r.ts,
  }));
  for (const provider of PROVIDERS) {
    if (views.some((v) => v.provider === provider)) continue;
    views.push({
      provider,
      window: "unknown",
      usedPercent: null,
      resetsAt: null,
      source: "unknown",
      ts: Date.now(),
    });
  }
  return views;
}
