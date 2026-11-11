import type { Database } from "bun:sqlite";
import { checkout, getTask, type MoveResult, release } from "../board/api";
import { MemoryError, type RemoteNoteEdit, updateNote, type Viewer } from "../memory/api";
import { getMember, projectAccess } from "../orgs/api";

const MAX_TTL_MS: number = 10 * 60_000;

type Forbidden = { ok: false; reason: "forbidden" };
const forbidden: Forbidden = { ok: false, reason: "forbidden" };

export type LeaseAnswer =
  | { ok: true; expiresAt: number }
  | Forbidden
  | Exclude<MoveResult, { ok: true }>;

export interface LeaseRequest {
  taskId: string;
  memberId: string;
  ttlMs: number;
  // A renewal never claims: it only extends a lease the home still counts as this holder's.
  renew?: boolean | undefined;
}

interface LeaseRow {
  holder_instance: string;
  holder_member: string;
  expires_at: number;
}

// A peer acts through one of the stub members of its own org that holds a write grant here. The
// member comes from the peer's request, so it is checked against the org that stands for that peer
// and against the role cap that applies to any grantee.
function peerMayWrite(db: Database, peerId: string, projectId: string, memberId: string): boolean {
  const granted = db
    .query(
      `SELECT 1 FROM members m JOIN orgs o ON o.id = m.org_id JOIN grants g ON g.org_id = o.id
       JOIN projects p ON p.id = g.project_id
       WHERE m.id = ?1 AND g.project_id = ?2 AND g.permission = 'write' AND o.home_instance = ?3
         AND p.home_instance IS NULL`,
    )
    .get(memberId, projectId, peerId);
  if (granted === null) return false;
  const access = projectAccess(db, { memberId }, projectId);
  return access === "write" || access === "admin";
}

function homeProjectOfTask(db: Database, taskId: string): string | null {
  return (
    db
      .query<{ project_id: string }, [string]>(
        `SELECT t.project_id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND p.home_instance IS NULL`,
      )
      .get(taskId)?.project_id ?? null
  );
}

// An expired lease gives the task back, but only when it still sits with the member the lease
// named: the home may have released or reassigned it by hand since.
export function sweepLeases(db: Database, now: number = Date.now()): number {
  const expired = db
    .query<{ task_id: string; holder_member: string }, [number]>(
      `SELECT l.task_id, l.holder_member FROM fed_leases l
       JOIN tasks t ON t.id = l.task_id JOIN projects p ON p.id = t.project_id
       WHERE l.expires_at <= ? AND p.home_instance IS NULL`,
    )
    .all(now);
  for (const { task_id, holder_member } of expired) {
    release(db, task_id, holder_member);
    db.run("DELETE FROM fed_leases WHERE task_id = ?", [task_id]);
  }
  return expired.length;
}

export function writeLease(
  db: Database,
  taskId: string,
  peerId: string,
  memberId: string,
  expiresAt: number,
): void {
  db.run(
    `INSERT INTO fed_leases (task_id, holder_instance, holder_member, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET holder_instance = excluded.holder_instance,
       holder_member = excluded.holder_member, expires_at = excluded.expires_at`,
    [taskId, peerId, memberId, expiresAt],
  );
}

// The claim itself is the board's atomic checkout under the peer's stub member, so a local checkout
// and a leased one cannot both win. A renewal is the same holder asking again while still holding.
export function grantLease(
  db: Database,
  peerId: string,
  req: LeaseRequest,
  now: number = Date.now(),
): LeaseAnswer {
  sweepLeases(db, now);
  const projectId = homeProjectOfTask(db, req.taskId);
  if (projectId === null || !peerMayWrite(db, peerId, projectId, req.memberId)) return forbidden;
  const row = db
    .query<LeaseRow, [string]>("SELECT * FROM fed_leases WHERE task_id = ?")
    .get(req.taskId);
  const renewing =
    row?.holder_instance === peerId &&
    row.holder_member === req.memberId &&
    getTask(db, req.taskId)?.holderId === req.memberId;
  if (req.renew === true && !renewing) return { ok: false, reason: "not_found" };
  if (!renewing) {
    const claimed = checkout(db, req.taskId, req.memberId);
    if (!claimed.ok) return claimed;
  }
  const expiresAt = now + Math.min(Math.max(req.ttlMs, 1), MAX_TTL_MS);
  writeLease(db, req.taskId, peerId, req.memberId, expiresAt);
  return { ok: true, expiresAt };
}

export function releaseLease(
  db: Database,
  peerId: string,
  req: { taskId: string; memberId: string },
): MoveResult | Forbidden {
  const projectId = homeProjectOfTask(db, req.taskId);
  if (projectId === null || !peerMayWrite(db, peerId, projectId, req.memberId)) return forbidden;
  const done = release(db, req.taskId, req.memberId);
  if (done.ok) db.run("DELETE FROM fed_leases WHERE task_id = ?", [req.taskId]);
  return done;
}

export type NoteAnswer = { hash: string } | "forbidden" | "conflict";

function viewerFor(
  db: Database,
  peerId: string,
  edit: Omit<RemoteNoteEdit, "projectId">,
): Viewer | null {
  const note = db
    .query<{ project_id: string; org_id: string }, [string]>(
      "SELECT project_id, org_id FROM notes WHERE id = ? AND scope = 'project'",
    )
    .get(edit.noteId);
  const member = getMember(db, edit.memberId);
  if (!note || !member || !peerMayWrite(db, peerId, note.project_id, edit.memberId)) return null;
  return {
    orgId: note.org_id,
    memberId: null,
    projectIds: [note.project_id],
    canWriteGlobal: false,
    canWrite: true,
    actor: member.handle,
  };
}

// The hash-checked write is the memory slice's own, run on the home with a viewer limited to the
// one project the peer holds a write grant for.
export function writePeerNote(
  db: Database,
  home: string,
  peerId: string,
  edit: Omit<RemoteNoteEdit, "projectId">,
): NoteAnswer {
  const viewer = viewerFor(db, peerId, edit);
  if (viewer === null) return "forbidden";
  try {
    const ctx = { viewer, runId: null };
    const { type, tags, confidence } = edit.meta;
    const meta = {
      ...(type !== undefined && { type }),
      ...(tags !== undefined && { tags }),
      ...(confidence !== undefined && { confidence }),
    };
    const saved = updateNote(db, home, ctx, edit.noteId, edit.baseHash, edit.text, meta);
    return { hash: saved.note.hash };
  } catch (e) {
    if (e instanceof MemoryError) return e.code === "conflict" ? "conflict" : "forbidden";
    throw e;
  }
}
