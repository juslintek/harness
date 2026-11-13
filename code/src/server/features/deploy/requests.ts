import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type TargetView, targetViewSchema } from "../../../shared/distribution";

type DeployStatus = "pending" | "approved" | "denied" | "running" | "done" | "failed";

export interface DeployRequest {
  id: string;
  target: TargetView;
  binaryPath: string;
  binarySha256: string;
  port: number;
  status: DeployStatus;
  requestedBy: string;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  result: unknown;
}

interface Row {
  id: string;
  target: string;
  binary_path: string;
  binary_sha256: string;
  port: number;
  status: DeployStatus;
  requested_by: string;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
  result: string | null;
}

const fromRow = (row: Row): DeployRequest => ({
  id: row.id,
  target: targetViewSchema.parse(JSON.parse(row.target)),
  binaryPath: row.binary_path,
  binarySha256: row.binary_sha256,
  port: row.port,
  status: row.status,
  requestedBy: row.requested_by,
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  result: row.result === null ? null : JSON.parse(row.result),
});

export function createRequest(
  db: Database,
  input: Pick<DeployRequest, "target" | "binaryPath" | "binarySha256" | "port" | "requestedBy">,
): DeployRequest {
  const id = Bun.randomUUIDv7();
  db.run(
    `INSERT INTO deploy_requests (id, target, binary_path, binary_sha256, port, status, requested_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      JSON.stringify(input.target),
      input.binaryPath,
      input.binarySha256,
      input.port,
      input.requestedBy,
      Date.now(),
    ],
  );
  return getRequest(db, id) as DeployRequest;
}

export function getRequest(db: Database, id: string): DeployRequest | null {
  const row = db.query<Row, [string]>("SELECT * FROM deploy_requests WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

export function listRequests(db: Database): DeployRequest[] {
  return db
    .query<Row, []>("SELECT * FROM deploy_requests ORDER BY created_at DESC, id DESC")
    .all()
    .map(fromRow);
}

// Each transition is one conditional UPDATE, so two callers racing for the same request cannot
// both win: the loser sees zero changed rows.
export function decide(
  db: Database,
  id: string,
  decision: "approve" | "deny",
  userId: string,
): "ok" | "missing" | "conflict" {
  const changed = db.run(
    "UPDATE deploy_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    [decision === "approve" ? "approved" : "denied", userId, Date.now(), id],
  ).changes;
  if (changed === 1) return "ok";
  return getRequest(db, id) ? "conflict" : "missing";
}

export function claimRun(db: Database, id: string): "ok" | "missing" | "conflict" {
  const changed = db.run(
    "UPDATE deploy_requests SET status = 'running' WHERE id = ? AND status = 'approved'",
    [id],
  ).changes;
  if (changed === 1) return "ok";
  return getRequest(db, id) ? "conflict" : "missing";
}

export function finish(db: Database, id: string, status: "done" | "failed", result: object): void {
  db.run("UPDATE deploy_requests SET status = ?, result = ? WHERE id = ? AND status = 'running'", [
    status,
    JSON.stringify(result),
    id,
  ]);
}

// A server that stopped mid-deploy leaves a row no process will move on.
export function failInterrupted(db: Database): void {
  db.run("UPDATE deploy_requests SET status = 'failed', result = ? WHERE status = 'running'", [
    JSON.stringify({ error: "server stopped during the deploy" }),
  ]);
}

export interface ResolvedBinary {
  path: string;
  sha256: string;
}

// The name must stay inside one of the allowed directories after symlinks are resolved, so a
// `..` or a link pointing out cannot make the executor copy an arbitrary file.
export async function resolveBinary(
  name: string,
  dirs: readonly string[],
): Promise<ResolvedBinary | null> {
  for (const dir of dirs) {
    try {
      const root = realpathSync(dir);
      const real = realpathSync(resolve(root, name));
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) continue;
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await Bun.file(real).arrayBuffer());
      return { path: real, sha256: hasher.digest("hex") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }
  return null;
}
