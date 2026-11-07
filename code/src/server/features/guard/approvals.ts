import type { Database } from "bun:sqlite";
import type { ApprovalView } from "../../../shared/runs";
import { notifyApproval } from "./approval-notifications";

type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRow {
  id: string;
  runId: string;
  action: string;
  l1: string;
  l2: string | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

interface DbApproval {
  id: string;
  run_id: string;
  action: string;
  l1: string;
  l2: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

type Final = Exclude<ApprovalStatus, "pending">;

// Resolved by decideApproval or by the expiry timer, whichever comes first.
const waiters = new Map<string, { db: Database; settle: (status: Final) => void }>();

function announce(db: Database, id: string): void {
  const row = getApproval(db, id);
  if (row) notifyApproval(approvalView(row));
}

function stopApprovalWaiters(db: Database): void {
  for (const waiter of waiters.values()) {
    if (waiter.db === db) waiter.settle("expired");
  }
}

export function createApproval(
  db: Database,
  input: { runId: string; action: string; l1: string; l2: string | null; timeoutMs: number },
): { id: string; expiresAt: number } {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  const expiresAt = now + input.timeoutMs;
  db.run(
    "INSERT INTO approvals (id, run_id, action, l1, l2, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    [id, input.runId, input.action, input.l1, input.l2, now, expiresAt],
  );
  return { id, expiresAt };
}

// `now` null means the timer fired, so expiry no longer depends on the clock comparison.
function markExpired(db: Database, id: string, now: number | null): boolean {
  const res = db.run(
    "UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending' AND expires_at <= ?",
    [id, now ?? Number.MAX_SAFE_INTEGER],
  );
  if (res.changes !== 1) return false;
  waiters.get(id)?.settle("expired");
  announce(db, id);
  return true;
}

export function awaitApproval(db: Database, id: string, expiresAt: number): Promise<Final> {
  return new Promise((resolve) => {
    const settle = (status: Final): void => {
      clearTimeout(timer);
      waiters.delete(id);
      resolve(status);
    };
    const timer = setTimeout(
      () => {
        if (markExpired(db, id, null)) return;
        const row = db
          .query<{ status: ApprovalStatus }, [string]>("SELECT status FROM approvals WHERE id = ?")
          .get(id);
        settle(row && row.status !== "pending" ? row.status : "expired");
      },
      Math.max(0, expiresAt - Date.now()),
    );
    waiters.set(id, { db, settle });
  });
}

export function decideApproval(
  db: Database,
  id: string,
  decision: "approve" | "deny",
  by: string,
): boolean {
  const now = Date.now();
  const status: Final = decision === "approve" ? "approved" : "denied";
  const res = db.run(
    "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
    [status, by, now, id, now],
  );
  if (res.changes === 1) {
    waiters.get(id)?.settle(status);
    announce(db, id);
    return true;
  }
  markExpired(db, id, now);
  return false;
}

function toRow(r: DbApproval): ApprovalRow {
  return {
    id: r.id,
    runId: r.run_id,
    action: r.action,
    l1: r.l1,
    l2: r.l2,
    status: r.status,
    decidedBy: r.decided_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
  };
}

export function listApprovals(db: Database, status?: string): ApprovalRow[] {
  const rows =
    status === undefined
      ? db.query<DbApproval, []>("SELECT * FROM approvals ORDER BY created_at, id").all()
      : db
          .query<DbApproval, [string]>(
            "SELECT * FROM approvals WHERE status = ? ORDER BY created_at, id",
          )
          .all(status);
  return rows.map(toRow);
}

export function expireApprovals(db: Database, now: number): number {
  const ids = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?",
    )
    .all(now);
  return ids.filter(({ id }) => markExpired(db, id, now)).length;
}

// Settles live waiters too, so a killed run does not keep a decide() promise and its timer.
export function expireRunApprovals(db: Database, runId: string): number {
  const run = db
    .query<{ member_id: string | null }, [string]>("SELECT member_id FROM runs WHERE id = ?")
    .get(runId);
  const ids = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'",
    )
    .all(runId);
  for (const { id } of ids) {
    if (run?.member_id) {
      waiters.get(id)?.settle("expired");
    } else {
      markExpired(db, id, null);
    }
  }
  return ids.length;
}

export function getApproval(db: Database, id: string): ApprovalRow | null {
  const row = db.query<DbApproval, [string]>("SELECT * FROM approvals WHERE id = ?").get(id);
  return row ? toRow(row) : null;
}

function parsed(json: string): { command?: unknown; paths?: unknown; reason?: unknown } {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

// The human decides on the raw command, so it is surfaced as-is (already redacted at creation).
export function approvalView(row: ApprovalRow): ApprovalView {
  const action = parsed(row.action);
  const command =
    typeof action.command === "string"
      ? action.command
      : Array.isArray(action.paths)
        ? action.paths.join(" ")
        : "";
  const reason = parsed(row.l1).reason;
  return {
    id: row.id,
    runId: row.runId,
    command,
    reason: typeof reason === "string" ? reason : null,
    status: row.status,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  };
}

// The run waiter may end before the human's decision window does.
export function startApprovalExpiry(db: Database): () => void {
  const sweep = (): void => {
    expireApprovals(db, Date.now());
  };
  sweep();
  const timer = setInterval(sweep, 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stopApprovalWaiters(db);
  };
}
