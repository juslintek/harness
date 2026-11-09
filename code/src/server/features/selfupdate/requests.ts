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
  log: string;
}

const LOG_CAP = 20_000;
const BUSY = ["queued", "checking", "building", "verifying", "swapping"];

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
    log: row.log,
  };
}

export function createRequest(
  db: Database,
  input: { repo: string; branch: string; commitSha: string; createdBy: string },
): UpdateRequest {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO update_requests (id, repo, branch, commit_sha, status, created_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
  ).run(id, input.repo, input.branch, input.commitSha, input.createdBy, Date.now());
  return getRequest(db, id) as UpdateRequest;
}

export function getRequest(db: Database, id: string): UpdateRequest | null {
  const row = db.query("SELECT * FROM update_requests WHERE id = ?").get(id) as Row | null;
  return row ? fromRow(row) : null;
}

export function hasBusyRequest(db: Database): boolean {
  const marks = BUSY.map(() => "?").join(",");
  return db.query(`SELECT 1 FROM update_requests WHERE status IN (${marks})`).get(...BUSY) !== null;
}

export function setStatus(db: Database, id: string, status: UpdateStatus, reason?: string): void {
  db.query("UPDATE update_requests SET status = ?, reason = COALESCE(?, reason) WHERE id = ?").run(
    status,
    reason ?? null,
    id,
  );
}

export function setFlagged(db: Database, id: string, paths: string[]): void {
  db.query("UPDATE update_requests SET flagged_paths = ? WHERE id = ?").run(
    JSON.stringify(paths),
    id,
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
// alone: the swap process owns that row and may still be writing it.
export function failInterrupted(db: Database): void {
  db.query(
    "UPDATE update_requests SET status = 'failed', reason = 'server stopped during the pipeline' WHERE status IN ('queued','checking','building','verifying')",
  ).run();
}
