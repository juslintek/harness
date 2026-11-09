import type { Database } from "bun:sqlite";

const STATUSES = [
  "queued",
  "awaiting_approval",
  "checking",
  "building",
  "verifying",
  "swapping",
  "done",
  "rolled_back",
  "failed",
  "denied",
] as const;
export type UpdateStatus = (typeof STATUSES)[number];

export interface UpdateRequest {
  id: string;
  repo: string;
  branch: string;
  commitSha: string;
  status: UpdateStatus;
  reason: string | null;
  flaggedPaths: string[];
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  log: string;
}

interface Row {
  id: string;
  repo: string;
  branch: string;
  commit_sha: string;
  status: UpdateStatus;
  reason: string | null;
  flagged_paths: string;
  created_by: string;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  log: string;
}

const LOG_CAP = 20_000;
// A swap that was killed leaves `swapping` behind, so it only counts as busy for a while; the
// other steps are bounded by their own timeouts and failInterrupted.
export const SWAP_BUSY_MS: number = 15 * 60 * 1000;
const BUSY_WHERE =
  "(status IN ('queued','checking','building','verifying') OR (status = 'swapping' AND swapping_at > ?))";
const INSERT =
  "INSERT INTO update_requests (id, repo, branch, commit_sha, status, created_by, created_at) SELECT ?, ?, ?, ?, 'queued', ?, ?";

function fromRow(row: Row): UpdateRequest {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    commitSha: row.commit_sha,
    status: row.status,
    reason: row.reason,
    flaggedPaths: JSON.parse(row.flagged_paths) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    log: row.log,
  };
}

type CreateInput = { repo: string; branch: string; commitSha: string; createdBy: string };

export function createRequest(db: Database, input: CreateInput): UpdateRequest {
  const id = Bun.randomUUIDv7();
  db.query(INSERT).run(id, input.repo, input.branch, input.commitSha, input.createdBy, Date.now());
  return getRequest(db, id) as UpdateRequest;
}

// The busy check and the insert are one statement, so two concurrent requests cannot both pass.
export function createIfIdle(db: Database, input: CreateInput): UpdateRequest | null {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  const inserted = db
    .query(`${INSERT} WHERE NOT EXISTS (SELECT 1 FROM update_requests WHERE ${BUSY_WHERE})`)
    .run(id, input.repo, input.branch, input.commitSha, input.createdBy, now, now - SWAP_BUSY_MS);
  return inserted.changes === 1 ? getRequest(db, id) : null;
}

export function getRequest(db: Database, id: string): UpdateRequest | null {
  const row = db.query("SELECT * FROM update_requests WHERE id = ?").get(id) as Row | null;
  return row ? fromRow(row) : null;
}

export function hasBusyRequest(db: Database): boolean {
  return (
    db.query(`SELECT 1 FROM update_requests WHERE ${BUSY_WHERE}`).get(Date.now() - SWAP_BUSY_MS) !==
    null
  );
}

export function setStatus(db: Database, id: string, status: UpdateStatus, reason?: string): void {
  db.query(
    "UPDATE update_requests SET status = ?, reason = COALESCE(?, reason), swapping_at = COALESCE(?, swapping_at) WHERE id = ?",
  ).run(status, reason ?? null, status === "swapping" ? Date.now() : null, id);
}

export function setFlagged(db: Database, id: string, paths: string[]): void {
  db.query("UPDATE update_requests SET flagged_paths = ? WHERE id = ?").run(
    JSON.stringify(paths),
    id,
  );
}

// Only a request still waiting can be decided, and only once: the WHERE makes approve and deny
// race safely.
export function decide(db: Database, id: string, to: "queued" | "denied", userId: string): boolean {
  return (
    db
      .query(
        "UPDATE update_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'awaiting_approval'",
      )
      .run(to, userId, Date.now(), id).changes === 1
  );
}

// Command output is kept as a tail so one chatty step cannot grow the row without bound.
export function appendLog(db: Database, id: string, text: string): void {
  const row = db.query("SELECT log FROM update_requests WHERE id = ?").get(id) as {
    log: string;
  } | null;
  if (!row) return;
  db.query("UPDATE update_requests SET log = ? WHERE id = ?").run(
    `${row.log}${text}\n`.slice(-LOG_CAP),
    id,
  );
}

// A server that died mid-pipeline leaves rows that no process will move on. `swapping` is left
// alone here: the swap process owns that row and may still be writing it (see failStaleSwaps).
export function failInterrupted(db: Database): void {
  db.query(
    "UPDATE update_requests SET status = 'failed', reason = 'server stopped during the pipeline' WHERE status IN ('queued','checking','building','verifying')",
  ).run();
}

export function swappingIds(db: Database): string[] {
  return db
    .query<{ id: string }, []>("SELECT id FROM update_requests WHERE status = 'swapping'")
    .all()
    .map((row) => row.id);
}

export function failSwap(db: Database, id: string): void {
  db.query(
    "UPDATE update_requests SET status = 'failed', reason = 'swap_interrupted' WHERE id = ? AND status = 'swapping'",
  ).run(id);
}
