import type { Database } from "bun:sqlite";
import { ensureInstance } from "../../db/db";
import { readNoteText, removeReplicatedNote, writeReplicatedNote } from "../memory/api";
import { flush, loadHlcState } from "./capture";
import type { NoteBodies } from "./schema";

export function noteBodies(db: Database, home: string): NoteBodies {
  return {
    read: (note) => readNoteText(home, String(note.disk)),
    write: (note, body) =>
      writeReplicatedNote(
        db,
        home,
        {
          disk: String(note.disk),
          org_id: String(note.org_id),
          project_id: String(note.project_id),
        },
        body,
      ),
    remove: (disk) => removeReplicatedNote(db, home, disk),
  };
}

// The clock lives in fed_state, loaded and saved around one synchronous flush, so the feed route
// and the pull loop never hold diverging copies.
export function flushPending(db: Database, home: string, wallMs: number = Date.now()): number {
  return flush(db, loadHlcState(db, ensureInstance(db)), noteBodies(db, home), wallMs);
}
