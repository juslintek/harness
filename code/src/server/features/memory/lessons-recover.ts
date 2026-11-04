import type { Database } from "bun:sqlite";
import { getTask } from "../board/api";
import { parseNote } from "./frontmatter";
import { type IndexedNote, type NoteRow, toIndexed } from "./index-repo";
import { getLesson } from "./lessons";
import { writeNote } from "./lessons-decide";
import { readNoteFile } from "./vault";

// The note a half-finished accept already wrote: same org, lesson and task tags, same body.
function existingNote(db: Database, home: string, orgId: string, number: number, body: string) {
  const rows = db
    .query<NoteRow, [string, string]>(
      `SELECT * FROM notes WHERE org_id = ? AND type = 'lesson'
       AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = 'lesson')
       AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)`,
    )
    .all(orgId, `task-${number}`);
  return rows
    .map(toIndexed)
    .find(
      (n: IndexedNote) => parseNote(readNoteFile(home, n.disk) ?? "").body.trim() === body.trim(),
    );
}

// A crash between the accept claim and the note write leaves a lesson accepted with no note. The
// reviewer already decided, so the note is finished here instead of putting the lesson back.
export async function finishAcceptedLessons(db: Database, home: string): Promise<void> {
  const ids = db
    .query<{ id: string }, []>(
      "SELECT id FROM lessons WHERE status = 'accepted' AND note_id IS NULL",
    )
    .all();
  for (const { id } of ids) {
    const lesson = getLesson(db, id);
    if (lesson === null) continue;
    try {
      const number = getTask(db, lesson.taskId)?.number ?? 0;
      const found = existingNote(db, home, lesson.orgId, number, lesson.body);
      const noteId = found?.id ?? (await writeNote(db, home, lesson, lesson.body));
      db.query("UPDATE lessons SET note_id = ? WHERE id = ? AND note_id IS NULL").run(noteId, id);
      console.error(`memory: ${found ? "linked" : "wrote"} the note of accepted lesson ${id}`);
    } catch (e) {
      console.error(`memory: could not finish accepted lesson ${id}: ${(e as Error).message}`);
    }
  }
}
