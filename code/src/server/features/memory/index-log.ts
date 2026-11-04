import type { Database } from "bun:sqlite";
import type { NoteWriteOp, NoteWriteView } from "../../../shared/memory";

export interface NoteWriteRow {
  noteId: string;
  disk: string;
  orgId: string | null;
  op: NoteWriteOp;
  actor: string;
  memberId: string | null;
  runId: string | null;
  beforeText: string | null;
  afterText: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export function logWrite(db: Database, w: Omit<NoteWriteRow, "id" | "at">): string {
  const id = Bun.randomUUIDv7();
  db.run(
    `INSERT INTO note_writes (id, note_id, disk, org_id, op, actor, member_id, run_id,
       before_text, after_text, before_hash, after_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      w.noteId,
      w.disk,
      w.orgId,
      w.op,
      w.actor,
      w.memberId,
      w.runId,
      w.beforeText,
      w.afterText,
      w.beforeHash,
      w.afterHash,
      Date.now(),
    ],
  );
  return id;
}

interface WriteRaw {
  id: string;
  note_id: string;
  disk: string;
  org_id: string | null;
  op: NoteWriteOp;
  actor: string;
  member_id: string | null;
  run_id: string | null;
  before_text: string | null;
  after_text: string | null;
  before_hash: string | null;
  after_hash: string | null;
  at: number;
}

export function listWrites(
  db: Database,
  orgId: string,
  opts: { limit: number; agentsOnly?: boolean },
): NoteWriteView[] {
  // An agent write always carries the run it happened in.
  const agents = opts.agentsOnly ? " AND run_id IS NOT NULL" : "";
  return db
    .query<WriteRaw, [string, number]>(
      `SELECT * FROM note_writes WHERE org_id = ?${agents} ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(orgId, opts.limit)
    .map((r) => ({
      id: r.id,
      noteId: r.note_id,
      path: r.disk,
      op: r.op,
      actor: r.actor,
      runId: r.run_id,
      at: r.at,
      beforeHash: r.before_hash,
      afterHash: r.after_hash,
    }));
}

export function getWrite(
  db: Database,
  orgId: string,
  id: string,
): (NoteWriteRow & { id: string; at: number }) | null {
  const r = db
    .query<WriteRaw, [string, string]>("SELECT * FROM note_writes WHERE id = ? AND org_id = ?")
    .get(id, orgId);
  if (r === null) return null;
  return {
    id: r.id,
    noteId: r.note_id,
    disk: r.disk,
    orgId: r.org_id,
    op: r.op,
    actor: r.actor,
    memberId: r.member_id,
    runId: r.run_id,
    beforeText: r.before_text,
    afterText: r.after_text,
    beforeHash: r.before_hash,
    afterHash: r.after_hash,
    at: r.at,
  };
}

export function logRead(
  db: Database,
  noteId: string,
  runId: string | null,
  memberId: string | null,
  via: "view" | "search" | "index",
): void {
  db.run("INSERT INTO note_reads (note_id, run_id, member_id, via, at) VALUES (?, ?, ?, ?, ?)", [
    noteId,
    runId,
    memberId,
    via,
    Date.now(),
  ]);
}
