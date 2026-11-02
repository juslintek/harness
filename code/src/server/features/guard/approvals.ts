import type { Database } from "bun:sqlite";

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
const waiters = new Map<string, (status: Final) => void>();

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
  return res.changes === 1;
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
        markExpired(db, id, null);
        const row = db
          .query<{ status: ApprovalStatus }, [string]>("SELECT status FROM approvals WHERE id = ?")
          .get(id);
        settle(row && row.status !== "pending" ? row.status : "expired");
      },
      Math.max(0, expiresAt - Date.now()),
    );
    waiters.set(id, settle);
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
    waiters.get(id)?.(status);
    return true;
  }
  if (markExpired(db, id, now)) waiters.get(id)?.("expired");
  return false;
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
  return rows.map((r) => ({
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
  }));
}

export function expireApprovals(db: Database, now: number): number {
  const res = db.run(
    "UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    [now],
  );
  return res.changes;
}

// Settles live waiters too, so a killed run does not keep a decide() promise and its timer.
export function expireRunApprovals(db: Database, runId: string): number {
  const ids = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'",
    )
    .all(runId);
  for (const { id } of ids) {
    if (markExpired(db, id, null)) waiters.get(id)?.("expired");
  }
  return ids.length;
}
