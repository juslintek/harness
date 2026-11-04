import type { Database } from "bun:sqlite";
import type { NoteScope, NoteSummary, NoteType } from "../../../shared/memory";
import { redact } from "../logs/api";
import { hashText, noteTitle, parseNote, wikilinks } from "./frontmatter";
import type { Located } from "./paths";

export type IndexedNote = NoteSummary & { disk: string; slug: string };

export interface NoteRow {
  id: string;
  disk: string;
  scope: NoteScope;
  org_id: string | null;
  project_id: string | null;
  member_id: string | null;
  type: NoteType;
  title: string;
  tags: string;
  source_agent: string | null;
  confidence: number | null;
  created: number;
  updated: number;
  hash: string;
  slug: string;
  snippet?: string;
}

export function toIndexed(r: NoteRow): IndexedNote {
  return {
    id: r.id,
    path: r.disk,
    disk: r.disk,
    slug: r.slug,
    scope: r.scope,
    orgId: r.org_id,
    projectId: r.project_id,
    memberId: r.member_id,
    type: r.type,
    title: r.title,
    tags: JSON.parse(r.tags) as string[],
    sourceAgent: r.source_agent ?? "outside",
    confidence: r.confidence ?? 1,
    created: new Date(r.created).toISOString(),
    updated: new Date(r.updated).toISOString(),
    hash: r.hash,
    ...(r.snippet === undefined ? {} : { snippet: r.snippet }),
  };
}

export function getIndexed(db: Database, id: string): IndexedNote | null {
  const r = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id);
  return r ? toIndexed(r) : null;
}

export function getIndexedByDisk(db: Database, disk: string): IndexedNote | null {
  const r = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE disk = ?").get(disk);
  return r ? toIndexed(r) : null;
}

function epoch(iso: string | undefined, fallback: number): number {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(t) ? fallback : t;
}

// Two files claiming one id: the row already indexed keeps it and the newcomer gets a fresh one,
// so audit rows and links written against the id stay with the note they were made for.
function pickId(db: Database, disk: string, wanted: string): string {
  const taken = db.query("SELECT 1 FROM notes WHERE id = ? AND disk != ?").get(wanted, disk);
  return taken === null ? wanted : Bun.randomUUIDv7();
}

function replaceFts(db: Database, disk: string, title: string, body: string, tags: string[]): void {
  const rowid = db
    .query<{ seq: number }, [string]>("SELECT seq FROM notes WHERE disk = ?")
    .get(disk)?.seq as number;
  db.run("DELETE FROM notes_fts WHERE rowid = ?", [rowid]);
  db.run("INSERT INTO notes_fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)", [
    rowid,
    title,
    body,
    tags.join(" "),
  ]);
}

// The location decides scope and owner; frontmatter cannot move a note into another org.
export function upsertIndexed(db: Database, loc: Located, text: string): IndexedNote {
  // Title, links and full-text come from the redacted text; the hash stays the raw file hash so
  // "disk hash equals index hash" still means no change.
  const { meta, body } = parseNote(redact(text));
  const now = Date.now();
  const title = noteTitle(body, loc.rel);
  const slug = (loc.rel.split("/").pop() ?? loc.rel).replace(/\.md$/, "").toLowerCase();
  const updated = epoch(meta.updated, now);
  db.transaction(() => {
    const prior = getIndexedByDisk(db, loc.disk);
    if (prior) db.run("DELETE FROM note_links WHERE src_id = ?", [prior.id]);
    const id = pickId(db, loc.disk, meta.id ?? prior?.id ?? Bun.randomUUIDv7());
    db.run(
      `INSERT INTO notes (id, disk, scope, org_id, project_id, member_id, type, title, tags,
         source_agent, confidence, created, updated, hash, slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(disk) DO UPDATE SET id = excluded.id, scope = excluded.scope,
         org_id = excluded.org_id, project_id = excluded.project_id, member_id = excluded.member_id,
         type = excluded.type, title = excluded.title, tags = excluded.tags,
         source_agent = excluded.source_agent, confidence = excluded.confidence,
         created = excluded.created, updated = excluded.updated, hash = excluded.hash,
         slug = excluded.slug`,
      [
        id,
        loc.disk,
        loc.scope,
        loc.orgId,
        loc.projectId,
        loc.memberId,
        meta.type ?? "fact",
        title,
        JSON.stringify(meta.tags),
        meta.sourceAgent ?? null,
        meta.confidence ?? null,
        epoch(meta.created, now),
        updated,
        hashText(text),
        slug,
      ],
    );
    for (const target of wikilinks(body)) {
      db.run("INSERT OR IGNORE INTO note_links (src_id, target) VALUES (?, ?)", [id, target]);
    }
    replaceFts(db, loc.disk, title, body, meta.tags);
  })();
  return getIndexedByDisk(db, loc.disk) as IndexedNote;
}

export function removeIndexed(db: Database, disk: string): string | null {
  const row = db
    .query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM notes WHERE disk = ?")
    .get(disk);
  if (row === null) return null;
  db.transaction(() => {
    db.run("DELETE FROM notes_fts WHERE rowid = ?", [row.seq]);
    db.run("DELETE FROM notes WHERE disk = ?", [disk]);
  })();
  return row.id;
}
