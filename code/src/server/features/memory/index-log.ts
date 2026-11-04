import type { Database } from "bun:sqlite";
import type { NoteWriteOp, NoteWriteView } from "../../../shared/memory";
import { redact } from "../logs/api";

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
      w.beforeText === null ? null : redact(w.beforeText),
      w.afterText === null ? null : redact(w.afterText),
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

// An outside edit of a global note is logged with no org. Only a viewer who may write global
// notes (an instance admin) is allowed to see and revert those rows.
const ORG_OR_GLOBAL = "(org_id = ?1 OR (?2 = 1 AND org_id IS NULL))";

interface WriteViewer {
  projectIds: string[];
  memberId: string | null;
}

// Mirrors canRead on the disk layout so the limit applies to rows the viewer may see; filtering
// after the limit would let a busy project they cannot read push every visible write off the page.
function visibleDisk(orgId: string, v: WriteViewer): { sql: string; params: string[] } {
  const prefix = (rest: string): string => `orgs/${orgId}/${rest}/`;
  const prefixes = [
    "global/",
    prefix("org"),
    ...v.projectIds.map((p) => prefix(`projects/${p}`)),
    prefix(v.memberId === null ? "agents" : `agents/${v.memberId}`),
  ];
  const sql = prefixes.map(() => "substr(disk, 1, length(?)) = ?").join(" OR ");
  return { sql: ` AND (${sql})`, params: prefixes.flatMap((x) => [x, x]) };
}

export function listWrites(
  db: Database,
  orgId: string,
  opts: { limit: number; agentsOnly?: boolean; includeGlobal?: boolean; viewer?: WriteViewer },
): NoteWriteView[] {
  // An agent write always carries the run it happened in.
  const agents = opts.agentsOnly ? " AND run_id IS NOT NULL" : "";
  const vis = opts.viewer ? visibleDisk(orgId, opts.viewer) : { sql: "", params: [] };
  return db
    .query<WriteRaw, Array<string | number>>(
      `SELECT * FROM note_writes WHERE ${ORG_OR_GLOBAL}${agents}${vis.sql} ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(orgId, opts.includeGlobal ? 1 : 0, ...vis.params, opts.limit)
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
  includeGlobal = false,
): (NoteWriteRow & { id: string; at: number }) | null {
  const r = db
    .query<WriteRaw, [string, number, string]>(
      `SELECT * FROM note_writes WHERE id = ?3 AND ${ORG_OR_GLOBAL}`,
    )
    .get(orgId, includeGlobal ? 1 : 0, id);
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
