import type { Database } from "bun:sqlite";
import { redact } from "../logs/api";
import { hashText, parseNote } from "./frontmatter";
import { getWrite } from "./index-log";
import { getIndexed } from "./index-repo";
import { canRead, diskToLocated } from "./paths";
import {
  drop,
  MemoryError,
  needWrite,
  persist,
  toView,
  type WriteCtx,
  type WriteResult,
} from "./store-kit";
import { readNoteFile } from "./vault";

// Undo is only safe while the file is still exactly what that write produced; anything newer
// would be lost, so a changed file is a conflict instead.
export function revertWrite(
  db: Database,
  home: string,
  ctx: WriteCtx,
  writeId: string,
): WriteResult {
  const w = getWrite(db, ctx.viewer.orgId, writeId);
  const loc = w === null ? null : diskToLocated(w.disk);
  if (w === null || loc === null || !canRead(ctx.viewer, loc)) {
    throw new MemoryError("not_found", "write not found");
  }
  needWrite(ctx.viewer, loc);
  if (w.op === "rename") throw new MemoryError("invalid", "rename back instead of reverting");
  const current = readNoteFile(home, w.disk);
  if ((current === null ? null : hashText(current)) !== w.afterHash) {
    throw new MemoryError("conflict", "note changed since that write");
  }
  if (w.beforeText === null && w.beforeHash !== null) {
    throw new MemoryError("invalid", "previous text unknown");
  }
  if (w.beforeText === null) {
    const note = getIndexed(db, w.noteId);
    if (note === null || current === null) throw new MemoryError("not_found", "note not found");
    drop(db, home, ctx, "revert", note.id, loc, current);
    return { note: toView(note, parseNote(current).body), redacted: false };
  }
  // The old text may come from an outside edit, which was never redacted.
  const restored = redact(w.beforeText);
  const note = persist(db, home, ctx, "revert", loc, current, restored);
  return { note: toView(note, parseNote(restored).body), redacted: restored !== w.beforeText };
}
