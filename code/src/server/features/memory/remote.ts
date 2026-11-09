import type { Database } from "bun:sqlite";
import type { NoteType } from "../../../shared/memory";
import type { NoteMeta } from "./frontmatter";
import { readNote, updateNote } from "./store";
import { locate, MemoryError, needWrite, type WriteCtx, type WriteResult } from "./store-kit";

export interface RemoteNoteEdit {
  projectId: string;
  noteId: string;
  memberId: string;
  baseHash: string;
  text: string;
  meta: {
    type?: NoteType | undefined;
    tags?: string[] | undefined;
    confidence?: number | undefined;
  };
}

// Set by the federation slice at startup, so memory never imports it. False means the project is
// not a remote copy and the local write runs; a refusal comes back as a MemoryError.
export type RemoteNoteWriter = (db: Database, edit: RemoteNoteEdit) => Promise<boolean>;

let writer: RemoteNoteWriter | null = null;

export function setRemoteNoteWriter(fn: RemoteNoteWriter | null): void {
  writer = fn;
}

// A note of a project whose home is another instance is written there, with the same hash check;
// the new text comes back through replication.
export async function saveNote(
  db: Database,
  home: string,
  ctx: WriteCtx,
  id: string,
  baseHash: string,
  body: string,
  meta: Partial<NoteMeta> = {},
): Promise<WriteResult> {
  const { loc } = locate(db, ctx.viewer, id);
  if (writer !== null && loc.scope === "project" && loc.projectId !== null) {
    needWrite(ctx.viewer, loc);
    const memberId = ctx.viewer.memberId;
    if (memberId === null) throw new MemoryError("forbidden", "no member to write as");
    const edit: RemoteNoteEdit = {
      projectId: loc.projectId,
      noteId: id,
      memberId,
      baseHash,
      text: body,
      meta: {
        ...(meta.type !== undefined && { type: meta.type }),
        ...(meta.tags !== undefined && { tags: meta.tags }),
        ...(meta.confidence !== undefined && { confidence: meta.confidence }),
      },
    };
    if (await writer(db, edit)) {
      return { note: readNote(db, home, ctx.viewer, id), redacted: false };
    }
  }
  return updateNote(db, home, ctx, id, baseHash, body, meta);
}
