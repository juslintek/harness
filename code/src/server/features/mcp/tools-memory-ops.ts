import type { Database } from "bun:sqlite";
import { classifyNote } from "../laya/api";
import { redact } from "../logs/api";
import {
  backlinks,
  createNote,
  deleteNote,
  getIndexedByDisk,
  type Located,
  logRead,
  MemoryError,
  type ProjectSlugs,
  readNote,
  renameNote,
  resolveNotePath,
  searchNotes,
  updateNote,
  type Viewer,
  virtualPathOf,
  type WriteCtx,
} from "../memory/api";
import { fail } from "./tools-kit";

type NoteScope = "global" | "org" | "project" | "agent";
type NoteType = "lesson" | "fact" | "decision" | "howto" | "reference";

export interface MemoryArgs {
  action:
    | "view"
    | "create"
    | "str_replace"
    | "insert"
    | "delete"
    | "rename"
    | "search"
    | "backlinks";
  path?: string | undefined;
  view_range?: number[] | undefined;
  file_text?: string | undefined;
  old_str?: string | undefined;
  new_str?: string | undefined;
  insert_line?: number | undefined;
  insert_text?: string | undefined;
  old_path?: string | undefined;
  new_path?: string | undefined;
  query?: string | undefined;
  scope?: NoteScope | undefined;
  type?: NoteType | undefined;
  tag?: string | undefined;
}

export interface Op {
  db: Database;
  home: string;
  viewer: Viewer;
  runId: string;
  slugs: ProjectSlugs;
  write: WriteCtx;
  projectId: string | null;
}

const MAX_LINES = 200;
const REDACTED = "Note: secrets were redacted before saving.";
const UNSCOPED = /^\/memories\/(?!(?:global|org|project|agent)(?:\/|$))(.+)$/;

function need(value: string | undefined, name: string): string {
  return value === undefined ? fail(`${name} is required`) : value;
}

function located(op: Op, vpath: string): Located {
  const r = resolveNotePath(vpath, op.viewer, op.slugs);
  if (r === null) return fail("invalid path");
  return r === "dir" ? fail("that path is a folder, not a note") : r;
}

function noteOf(op: Op, vpath: string): { id: string; hash: string; body: string } {
  const loc = located(op, vpath);
  const row = getIndexedByDisk(op.db, loc.disk);
  if (row === null) return fail("note not found");
  const note = readNote(op.db, op.home, op.viewer, row.id);
  return { id: note.id, hash: note.hash, body: note.body };
}

function withNotice(text: string, redacted: boolean): string {
  return redacted ? `${text}\n${REDACTED}` : text;
}

function numbered(body: string, range: number[] | undefined): string {
  const lines = body.split("\n");
  const [from = 1, to = lines.length] = range ?? [];
  const end = to === -1 ? lines.length : to;
  if (from < 1 || end < from || from > lines.length) return fail("invalid view_range");
  return lines
    .slice(from - 1, end)
    .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
    .join("\n");
}

// Scope roots and project roots always exist; anything below them is a folder only if it holds notes.
function isNested(vpath: string): boolean {
  const p = vpath.split("/");
  return p.length > (p[2] === "project" ? 4 : 3);
}

function listDir(op: Op, vpath: string): string {
  const [, , scope, slug] = vpath.split("/");
  if (scope === undefined) {
    return ["agent", "org", "global", "project"].map((s) => `/memories/${s}/`).join("\n");
  }
  if (scope === "project" && slug === undefined) {
    return op.viewer.projectIds.map((id) => `/memories/project/${op.slugs.slugOf(id)}/`).join("\n");
  }
  // The folder is filtered in SQL, otherwise an older-only folder would fall outside the newest notes.
  const probe = resolveNotePath(`${vpath}/x.md`, op.viewer, op.slugs);
  if (probe === null || probe === "dir") return fail("invalid path");
  const hits = searchNotes(op.db, op.viewer, {
    pathPrefix: probe.disk.slice(0, -"x.md".length),
    limit: MAX_LINES,
  });
  const lines = hits.map((n) => `${virtualPathOf(n, op.slugs)} — ${n.title}`);
  if (lines.length === 0 && isNested(vpath)) return fail("not found");
  return lines.join("\n");
}

function view(op: Op, a: MemoryArgs): string {
  const raw = need(a.path, "path");
  const vpath = raw.length > 1 ? raw.replace(/\/$/, "") : raw;
  const r = resolveNotePath(vpath, op.viewer, op.slugs);
  if (r === null) return fail("invalid path");
  if (r === "dir") return listDir(op, vpath);
  const note = noteOf(op, vpath);
  logRead(op.db, note.id, op.runId, op.viewer.memberId, "view");
  return numbered(note.body, a.view_range);
}

// A path without a scope lets the classifier choose where the note belongs; the run's project
// is only offered when the viewer can still reach it.
async function createTarget(
  op: Op,
  path: string,
  text: string,
): Promise<{ loc: Located; type?: NoteType }> {
  const rel = UNSCOPED.exec(path)?.[1];
  if (rel === undefined) return { loc: located(op, path) };
  const projectId =
    op.projectId !== null && op.viewer.projectIds.includes(op.projectId) ? op.projectId : null;
  // The classifier is a network call, so it only ever sees redacted text.
  const cls = await classifyNote(
    redact(text),
    projectId === null ? ["agent", "org"] : ["project", "agent", "org"],
  );
  const dir =
    cls.scope === "project" && projectId !== null
      ? `project/${op.slugs.slugOf(projectId)}`
      : cls.scope === "project"
        ? "agent"
        : cls.scope;
  return { loc: located(op, `/memories/${dir}/${rel}`), type: cls.type };
}

async function create(op: Op, a: MemoryArgs): Promise<string> {
  const path = need(a.path, "path");
  const text = need(a.file_text, "file_text");
  const { loc, type } = await createTarget(op, path, text);
  const res = await createNote(op.db, op.home, op.write, loc, text, type ? { type } : {});
  return withNotice(`created ${virtualPathOf(res.note, op.slugs)}`, res.redacted);
}

function strReplace(op: Op, a: MemoryArgs): string {
  const path = need(a.path, "path");
  const oldStr = need(a.old_str, "old_str");
  const note = noteOf(op, path);
  const count = oldStr === "" ? 0 : note.body.split(oldStr).length - 1;
  if (count === 0) return fail("old_str not found in the note");
  if (count > 1) return fail(`old_str appears ${count} times, make it unique`);
  const next = note.body.replace(oldStr, () => a.new_str ?? "");
  const res = updateNote(op.db, op.home, op.write, note.id, note.hash, next);
  return withNotice(`edited ${path}`, res.redacted);
}

function insert(op: Op, a: MemoryArgs): string {
  const path = need(a.path, "path");
  const at = a.insert_line ?? fail("insert_line is required");
  const text = need(a.insert_text, "insert_text");
  const note = noteOf(op, path);
  const trailing = note.body.endsWith("\n");
  const lines = (trailing ? note.body.slice(0, -1) : note.body).split("\n");
  if (at > lines.length) return fail(`insert_line must be 0..${lines.length}`);
  lines.splice(at, 0, ...text.split("\n"));
  const next = lines.join("\n") + (trailing ? "\n" : "");
  const res = updateNote(op.db, op.home, op.write, note.id, note.hash, next);
  return withNotice(`edited ${path}`, res.redacted);
}

function remove(op: Op, a: MemoryArgs): string {
  const path = need(a.path, "path");
  const note = noteOf(op, path);
  deleteNote(op.db, op.home, op.write, note.id, note.hash);
  return `deleted ${path}`;
}

function rename(op: Op, a: MemoryArgs): string {
  const from = need(a.old_path, "old_path");
  const to = located(op, need(a.new_path, "new_path"));
  const note = noteOf(op, from);
  const moved = renameNote(op.db, op.home, op.write, note.id, note.hash, to);
  return `renamed ${from} to ${virtualPathOf(moved, op.slugs)}`;
}

function search(op: Op, a: MemoryArgs): string {
  const hits = searchNotes(op.db, op.viewer, {
    ...(a.query === undefined ? {} : { text: a.query }),
    ...(a.scope === undefined ? {} : { scope: a.scope }),
    ...(a.type === undefined ? {} : { type: a.type }),
    ...(a.tag === undefined ? {} : { tag: a.tag }),
  });
  for (const n of hits) logRead(op.db, n.id, op.runId, op.viewer.memberId, "search");
  if (hits.length === 0) return "no matches";
  return hits
    .map((n) => {
      const snippet = (n.snippet ?? "").replace(/\s+/g, " ").trim();
      return `${virtualPathOf(n, op.slugs)} — ${n.title} — ${snippet}`;
    })
    .join("\n");
}

function links(op: Op, a: MemoryArgs): string {
  const note = noteOf(op, need(a.path, "path"));
  const hits = backlinks(op.db, op.viewer, note.id);
  if (hits.length === 0) return "no backlinks";
  return hits.map((n) => `${virtualPathOf(n, op.slugs)} — ${n.title}`).join("\n");
}

const ACTIONS: Record<MemoryArgs["action"], (op: Op, a: MemoryArgs) => string | Promise<string>> = {
  view,
  create,
  str_replace: strReplace,
  insert,
  delete: remove,
  rename,
  search,
  backlinks: links,
};

const CODE_MESSAGES: Record<string, string> = {
  conflict: "the note changed since you read it; view it again",
  not_found: "note not found",
  forbidden: "you are not allowed to do that here",
  exists: "a note already exists there",
};

export async function runCommand(op: Op, a: MemoryArgs): Promise<string> {
  try {
    return await ACTIONS[a.action](op, a);
  } catch (e) {
    if (e instanceof MemoryError) return fail(CODE_MESSAGES[e.code] ?? e.message);
    throw e;
  }
}
