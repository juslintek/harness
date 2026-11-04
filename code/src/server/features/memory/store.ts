import type { Database } from "bun:sqlite";
import type { NoteScope, NoteType, NoteView } from "../../../shared/memory";
import { hashText, type NoteMeta, parseNote, serializeNote } from "./frontmatter";
import { removeIndexed, upsertIndexed } from "./index-repo";
import type { Located, Viewer } from "./paths";
import { canWrite } from "./paths";
import {
  checkBase,
  diskText,
  drop,
  locate,
  MemoryError,
  moved,
  needWrite,
  persist,
  scrub,
  toView,
  type WriteCtx,
  type WriteResult,
} from "./store-kit";
import { readNoteFile } from "./vault";

type Patch = Partial<NoteMeta>;

function validConfidence(c: number | undefined): boolean {
  return c === undefined || (Number.isFinite(c) && c >= 0 && c <= 1);
}

async function pickType(ctx: WriteCtx, loc: Located, body: string, meta: Patch): Promise<NoteType> {
  if (meta.type !== undefined) return meta.type;
  if (ctx.classify === undefined) return "fact";
  try {
    // The location fixes the scope, so it is the only one the classifier may pick.
    return (await ctx.classify(body, [loc.scope as NoteScope])).type;
  } catch {
    return "fact";
  }
}

export async function createNote(
  db: Database,
  home: string,
  ctx: WriteCtx,
  loc: Located,
  body: string,
  meta: Patch = {},
): Promise<WriteResult> {
  needWrite(ctx.viewer, loc);
  if (!validConfidence(meta.confidence)) throw new MemoryError("invalid", "confidence is 0..1");
  const type = await pickType(ctx, loc, body, meta);
  // Everything below is synchronous: the await above is the only gap, so "exists" is checked after it.
  if (readNoteFile(home, loc.disk) !== null) throw new MemoryError("exists", "note already exists");
  const now = new Date().toISOString();
  const clean = scrub(
    {
      id: Bun.randomUUIDv7(),
      type,
      scope: loc.scope,
      tags: meta.tags ?? [],
      sourceAgent: ctx.viewer.actor,
      created: now,
      updated: now,
      confidence: meta.confidence ?? 0.5,
      extra: {},
    },
    body,
  );
  const text = serializeNote(clean.meta, clean.body);
  const note = persist(db, home, ctx, "create", loc, null, text);
  return { note: toView(note, clean.body), redacted: clean.redacted };
}

function merged(old: NoteMeta, id: string, loc: Located, patch: Patch, now: string): NoteMeta {
  const next: NoteMeta = { ...old, id, scope: loc.scope, updated: now };
  next.created ??= now;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.confidence !== undefined) next.confidence = patch.confidence;
  return next;
}

export function updateNote(
  db: Database,
  home: string,
  ctx: WriteCtx,
  id: string,
  baseHash: string,
  nextBody: string,
  meta: Patch = {},
): WriteResult {
  const { note, loc } = locate(db, ctx.viewer, id);
  needWrite(ctx.viewer, loc);
  if (!validConfidence(meta.confidence)) throw new MemoryError("invalid", "confidence is 0..1");
  const before = diskText(home, loc.disk);
  checkBase(before, baseHash);
  const next = merged(parseNote(before).meta, note.id, loc, meta, new Date().toISOString());
  const clean = scrub(next, nextBody);
  const after = serializeNote(clean.meta, clean.body);
  const saved = persist(db, home, ctx, "update", loc, before, after);
  return { note: toView(saved, clean.body), redacted: clean.redacted };
}

export function deleteNote(
  db: Database,
  home: string,
  ctx: WriteCtx,
  id: string,
  baseHash: string,
): void {
  const { note, loc } = locate(db, ctx.viewer, id);
  needWrite(ctx.viewer, loc);
  const before = diskText(home, loc.disk);
  checkBase(before, baseHash);
  drop(db, home, ctx, "delete", note.id, loc, before);
}

export function renameNote(
  db: Database,
  home: string,
  ctx: WriteCtx,
  id: string,
  baseHash: string,
  to: Located,
): NoteView {
  const { note, loc } = locate(db, ctx.viewer, id);
  needWrite(ctx.viewer, loc);
  if (to.orgId !== loc.orgId) throw new MemoryError("invalid", "a note cannot change org");
  if (!canWrite(ctx.viewer, to)) throw new MemoryError("forbidden", "not allowed to write there");
  const before = diskText(home, loc.disk);
  checkBase(before, baseHash);
  if (to.disk === loc.disk || readNoteFile(home, to.disk) !== null) {
    throw new MemoryError("exists", "target already exists");
  }
  const parsed = parseNote(before);
  const clean = scrub(merged(parsed.meta, note.id, to, {}, new Date().toISOString()), parsed.body);
  const after = serializeNote(clean.meta, clean.body);
  const next = moved(db, home, ctx, loc, to, before, after);
  return toView(next, clean.body);
}

export function readNote(db: Database, home: string, viewer: Viewer, id: string): NoteView {
  const { note, loc } = locate(db, viewer, id);
  const text = readNoteFile(home, loc.disk);
  if (text === null) {
    removeIndexed(db, loc.disk);
    throw new MemoryError("not_found", "note file is missing");
  }
  const fresh = note.hash === hashText(text) ? note : upsertIndexed(db, loc, text);
  return toView(fresh, parseNote(text).body);
}
