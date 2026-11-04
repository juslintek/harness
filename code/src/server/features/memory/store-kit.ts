import type { Database } from "bun:sqlite";
import type { NoteView } from "../../../shared/memory";
import { redact } from "../logs/api";
import { hashText, type NoteMeta } from "./frontmatter";
import { queueCommit } from "./git-log";
import { logWrite } from "./index-log";
import {
  getIndexed,
  type IndexedNote,
  removeIndexed,
  toSummary,
  upsertIndexed,
} from "./index-repo";
import { canRead, canWrite, diskToLocated, type Located, type Viewer } from "./paths";
import { FileChanged, readNoteFile, removeNoteFile, writeNoteFileAtomic } from "./vault";

export type MemoryErrorCode = "not_found" | "conflict" | "forbidden" | "invalid" | "exists";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WriteCtx {
  viewer: Viewer;
  runId: string | null;
  // Rebuilds the viewer from the database; null once the member is gone. Set where a write can
  // wait on something slow first, so a role change during the wait is seen before the file is written.
  refreshViewer?: () => Viewer | null;
  classify?: (
    body: string,
    allowed: NoteView["scope"][],
  ) => Promise<{ type: NoteView["type"]; scope: NoteView["scope"]; confidence: number }>;
}

export interface WriteResult {
  note: NoteView;
  redacted: boolean;
}

type Listener = (e: { orgId: string | null; noteId: string }) => void;
const listeners = new Set<Listener>();

export function onMemoryChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(orgId: string | null, noteId: string): void {
  for (const fn of listeners) {
    try {
      fn({ orgId, noteId });
    } catch {
      // A broken subscriber must not undo a write that already happened.
    }
  }
}

export function emitOutside(orgId: string | null, noteId: string): void {
  emit(orgId, noteId);
}

export function toView(n: IndexedNote, body: string, viewer: Viewer): NoteView {
  const { snippet: _snippet, ...summary } = toSummary(n);
  const loc = diskToLocated(n.disk);
  return { ...summary, body, canWrite: loc !== null && canWrite(viewer, loc) };
}

function cleanDeep(value: unknown, clean: (s: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((v) => cleanDeep(v, clean));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v, clean)]));
  }
  return value;
}

export function scrub(
  meta: NoteMeta,
  body: string,
): { meta: NoteMeta; body: string; redacted: boolean } {
  let redacted = false;
  const clean = (s: string): string => {
    const out = redact(s);
    if (out !== s) redacted = true;
    return out;
  };
  const next: NoteMeta = {
    ...meta,
    tags: meta.tags.map(clean),
    extra: cleanDeep(meta.extra, clean) as Record<string, unknown>,
  };
  if (meta.sourceAgent !== undefined) next.sourceAgent = clean(meta.sourceAgent);
  return { meta: next, body: clean(body), redacted };
}

// An id outside the viewer's reach looks the same as a missing one, so ids do not leak across orgs.
export function locate(
  db: Database,
  viewer: Viewer,
  id: string,
): { note: IndexedNote; loc: Located } {
  const note = getIndexed(db, id);
  const loc = note === null ? null : diskToLocated(note.disk);
  if (note === null || loc === null || !canRead(viewer, loc)) {
    throw new MemoryError("not_found", "note not found");
  }
  return { note, loc };
}

export function needWrite(viewer: Viewer, loc: Located): void {
  if (!canWrite(viewer, loc)) throw new MemoryError("forbidden", "not allowed to write this note");
}

export function checkBase(text: string, baseHash: string): void {
  if (hashText(text) !== baseHash) {
    throw new MemoryError("conflict", "note changed since it was read");
  }
}

export function diskText(home: string, disk: string): string {
  const text = readNoteFile(home, disk);
  if (text === null) throw new MemoryError("not_found", "note file is missing");
  return text;
}

interface Change {
  op: "create" | "update" | "delete" | "rename" | "revert";
  loc: Located;
  noteId: string;
  before: string | null;
  after: string | null;
}

// Global writes are logged under the writer's org, otherwise nobody could review or revert them.
// The change event keeps a null org for them: a global note is visible in every org.
function record(db: Database, home: string, ctx: WriteCtx, c: Change): void {
  logWrite(db, {
    noteId: c.noteId,
    disk: c.loc.disk,
    orgId: c.loc.orgId ?? ctx.viewer.orgId,
    op: c.op,
    actor: ctx.viewer.actor,
    memberId: ctx.viewer.memberId,
    runId: ctx.runId,
    beforeText: c.before,
    afterText: c.after,
    beforeHash: c.before === null ? null : hashText(c.before),
    afterHash: c.after === null ? null : hashText(c.after),
  });
  queueCommit(home, `${c.op} ${c.loc.disk}`, db);
  emit(c.loc.orgId, c.noteId);
}

function ioError(e: unknown): MemoryError {
  if (e instanceof FileChanged) return new MemoryError("conflict", e.message);
  return new MemoryError("invalid", (e as Error).message);
}

const hashOrNull = (text: string | null): string | null => (text === null ? null : hashText(text));

// Must stay synchronous: callers have just checked the base hash and nothing may run between
// that check and the rename.
export function persist(
  db: Database,
  home: string,
  ctx: WriteCtx,
  op: "create" | "update" | "revert",
  loc: Located,
  before: string | null,
  after: string,
): IndexedNote {
  try {
    writeNoteFileAtomic(home, loc.disk, after, hashOrNull(before));
  } catch (e) {
    throw ioError(e);
  }
  const note = upsertIndexed(db, loc, after, home);
  record(db, home, ctx, { op, loc, noteId: note.id, before, after });
  return note;
}

export function drop(
  db: Database,
  home: string,
  ctx: WriteCtx,
  op: "delete" | "revert",
  noteId: string,
  loc: Located,
  before: string,
): void {
  try {
    removeNoteFile(home, loc.disk, hashText(before));
  } catch (e) {
    throw ioError(e);
  }
  removeIndexed(db, loc.disk);
  record(db, home, ctx, { op, loc, noteId, before, after: null });
}

// A rename is write-new then remove-old. If the removal fails the old file still has the index
// row, so the new copy has to go or the same note would live in two files.
function undoCopyOnFailure(
  home: string,
  from: Located,
  to: Located,
  before: string,
  after: string,
): void {
  try {
    removeNoteFile(home, from.disk, hashText(before));
  } catch (e) {
    try {
      removeNoteFile(home, to.disk, hashText(after));
    } catch {
      // Best effort: the failure of the first removal is the one worth reporting.
    }
    throw e;
  }
}

export function moved(
  db: Database,
  home: string,
  ctx: WriteCtx,
  from: Located,
  to: Located,
  before: string,
  after: string,
): IndexedNote {
  try {
    writeNoteFileAtomic(home, to.disk, after, null);
    undoCopyOnFailure(home, from, to, before, after);
  } catch (e) {
    throw ioError(e);
  }
  // The old row goes first, otherwise the shared id would read as a duplicate and be split.
  removeIndexed(db, from.disk);
  const next = upsertIndexed(db, to, after, home);
  record(db, home, ctx, { op: "rename", loc: to, noteId: next.id, before, after });
  return next;
}
