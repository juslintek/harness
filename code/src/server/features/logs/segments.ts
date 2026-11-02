import type { Database } from "bun:sqlite";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const DEFAULT_MIN_BYTES = 262144;
const MAX_RAW_BYTES = 262144;
const LEVEL = 3;

interface PendingRow {
  event_rowid: number;
  body: string;
}

function seal(db: Database, runId: string | null, rows: PendingRow[]): void {
  const parts = rows.map((r) => Buffer.from(r.body, "utf8"));
  const raw = Buffer.concat(parts);
  const compressed = zstdCompressSync(raw, {
    params: { [constants.ZSTD_c_compressionLevel]: LEVEL },
  });
  const id = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO segments (id, run_id, created_at, level, raw_len, bytes) VALUES (?, ?, ?, ?, ?, ?)",
    [id, runId, Date.now(), LEVEL, raw.length, compressed],
  );
  let offset = 0;
  rows.forEach((row, i) => {
    const len = parts[i]?.length ?? 0;
    db.run("UPDATE events SET segment_id = ?, seg_offset = ?, seg_len = ? WHERE rowid = ?", [
      id,
      offset,
      len,
      row.event_rowid,
    ]);
    db.run("DELETE FROM pending_payloads WHERE event_rowid = ?", [row.event_rowid]);
    offset += len;
  });
}

function sealRun(db: Database, runId: string | null): number {
  const rows = db
    .query<PendingRow, [string | null]>(
      "SELECT event_rowid, body FROM pending_payloads WHERE run_id IS ? ORDER BY event_rowid",
    )
    .all(runId);
  let written = 0;
  let batch: PendingRow[] = [];
  let size = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    seal(db, runId, batch);
    written += 1;
    batch = [];
    size = 0;
  };
  for (const row of rows) {
    batch.push(row);
    size += Buffer.byteLength(row.body, "utf8");
    if (size >= MAX_RAW_BYTES) flush();
  }
  flush();
  return written;
}

export function sealPending(db: Database, runId: string | undefined, minBytes: number): number {
  return db.transaction((): number => {
    if (runId !== undefined) return sealRun(db, runId);
    const runs = db
      .query<{ run_id: string | null }, [number]>(
        `SELECT run_id FROM pending_payloads GROUP BY run_id
         HAVING SUM(length(CAST(body AS BLOB))) >= ?`,
      )
      .all(minBytes);
    return runs.reduce((n, r) => n + sealRun(db, r.run_id), 0);
  })();
}

export function readSegmentBody(
  db: Database,
  segmentId: string,
  offset: number,
  len: number,
): string | null {
  const row = db
    .query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM segments WHERE id = ?")
    .get(segmentId);
  if (!row) return null;
  const raw = zstdDecompressSync(row.bytes);
  return raw.subarray(offset, offset + len).toString("utf8");
}
