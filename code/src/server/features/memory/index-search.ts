import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import type { NoteScope, NoteSummary, NoteType } from "../../../shared/memory";
import { type IndexedNote, type NoteRow, toIndexed } from "./index-repo";
import type { Viewer } from "./paths";

export interface NoteQuery {
  text?: string;
  scope?: NoteScope;
  type?: NoteType;
  tag?: string;
  sourceAgent?: string;
  projectId?: string;
  // Disk path prefix (a folder, with its trailing slash); matched literally, not as a pattern.
  pathPrefix?: string;
  // Task text is long and its words rarely all occur in one note, so a prompt query ranks by bm25
  // over any word instead of requiring every word.
  anyWord?: boolean;
  limit?: number;
}

// Notes without a source_agent show as "outside" in the API, so filters and facets use the same name.
const SOURCE = "COALESCE(n.source_agent, 'outside')";

type Param = string | number | null;

// Visibility lives in SQL so a row of another org never leaves the database.
function visible(viewer: Viewer): { sql: string; params: Param[] } {
  const marks = viewer.projectIds.map(() => "?").join(", ");
  const sql = `(n.scope = 'global' OR (n.org_id = ? AND (n.scope = 'org'
    OR (n.scope = 'project' AND n.project_id IN (${marks}))
    OR (n.scope = 'agent' AND (? IS NULL OR n.member_id = ?)))))`;
  return { sql, params: [viewer.orgId, ...viewer.projectIds, viewer.memberId, viewer.memberId] };
}

function filters(viewer: Viewer, q: NoteQuery): { where: string[]; params: Param[] } {
  const v = visible(viewer);
  const where = [v.sql];
  const params = [...v.params];
  const eq: Array<[string, string | undefined]> = [
    ["n.scope", q.scope],
    ["n.type", q.type],
    [SOURCE, q.sourceAgent],
    ["n.project_id", q.projectId],
  ];
  for (const [col, val] of eq) {
    if (val === undefined) continue;
    where.push(`${col} = ?`);
    params.push(val);
  }
  if (q.pathPrefix !== undefined) {
    where.push("n.disk LIKE ? ESCAPE '\\'");
    params.push(`${q.pathPrefix.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (q.tag !== undefined) {
    where.push("EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)");
    params.push(q.tag);
  }
  return { where, params };
}

const MAX_ANY_WORDS = 16;

function ftsQuery(text: string, anyWord: boolean): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!anyWord) return words.length === 0 ? null : words.map((w) => `"${w}"`).join(" ");
  const long = [...new Set(words.filter((w) => w.length >= 3).map((w) => w.toLowerCase()))];
  return long.length === 0
    ? null
    : long
        .slice(0, MAX_ANY_WORDS)
        .map((w) => `"${w}"`)
        .join(" OR ");
}

export function searchNotes(db: Database, viewer: Viewer, q: NoteQuery): NoteSummary[] {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
  const { where, params } = filters(viewer, q);
  const text = q.text?.trim();
  if (text === undefined || text === "") {
    const sql = `SELECT n.* FROM notes n WHERE ${where.join(" AND ")} ORDER BY n.updated DESC LIMIT ?`;
    return db
      .query<NoteRow, Param[]>(sql)
      .all(...params, limit)
      .map(toIndexed);
  }
  const match = ftsQuery(text, q.anyWord === true);
  if (match === null) return [];
  const sql = `SELECT n.*, snippet(notes_fts, 1, '[', ']', '…', 12) AS snippet
    FROM notes_fts JOIN notes n ON n.seq = notes_fts.rowid
    WHERE notes_fts MATCH ? AND ${where.join(" AND ")}
    ORDER BY bm25(notes_fts), n.updated DESC LIMIT ?`;
  return db
    .query<NoteRow, Param[]>(sql)
    .all(match, ...params, limit)
    .map(toIndexed);
}

function count(
  db: Database,
  viewer: Viewer,
  expr: string,
  from = "notes n",
): Record<string, number> {
  const v = visible(viewer);
  const rows = db
    .query<{ k: string; c: number }, Param[]>(
      `SELECT ${expr} AS k, COUNT(*) AS c FROM ${from} WHERE ${v.sql} AND ${expr} IS NOT NULL GROUP BY k`,
    )
    .all(...v.params);
  return Object.fromEntries(rows.map((r) => [r.k, r.c]));
}

export function facets(
  db: Database,
  viewer: Viewer,
): {
  scopes: Record<string, number>;
  types: Record<string, number>;
  tags: Record<string, number>;
  sources: Record<string, number>;
} {
  return {
    scopes: count(db, viewer, "n.scope"),
    types: count(db, viewer, "n.type"),
    tags: count(db, viewer, "j.value", "notes n, json_each(n.tags) j"),
    sources: count(db, viewer, SOURCE),
  };
}

export function backlinks(db: Database, viewer: Viewer, noteId: string): NoteSummary[] {
  const target = db
    .query<{ slug: string; title: string }, [string]>("SELECT slug, title FROM notes WHERE id = ?")
    .get(noteId);
  if (target === null) return [];
  const v = visible(viewer);
  return db
    .query<NoteRow, Param[]>(
      `SELECT n.* FROM notes n WHERE n.id != ? AND ${v.sql} AND EXISTS (
         SELECT 1 FROM note_links l WHERE l.src_id = n.id AND l.target IN (?, ?))
       ORDER BY n.updated DESC`,
    )
    .all(noteId, ...v.params, target.slug, target.title.toLowerCase())
    .map(toIndexed);
}

const SCOPE_RANK: Record<NoteScope, number> = { agent: 0, project: 1, org: 2, global: 3 };

export function resolveWikilink(
  db: Database,
  viewer: Viewer,
  target: string,
  fromDisk: string,
): IndexedNote | null {
  const t = target.trim().toLowerCase();
  const v = visible(viewer);
  const rows = db
    .query<NoteRow, Param[]>(
      `SELECT n.* FROM notes n WHERE ${v.sql} AND (n.slug = ? OR lower(n.title) = ?)`,
    )
    .all(...v.params, t, t)
    .map(toIndexed);
  const dir = dirname(fromDisk);
  const rank = (n: IndexedNote): number => (dirname(n.disk) === dir ? 0 : 10) + SCOPE_RANK[n.scope];
  return rows.sort((a, b) => rank(a) - rank(b) || a.disk.localeCompare(b.disk))[0] ?? null;
}
