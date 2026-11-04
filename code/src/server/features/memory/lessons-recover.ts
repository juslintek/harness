import type { Database } from "bun:sqlite";
import type { LessonView } from "../../../shared/memory";
import { type NoteRow, toIndexed } from "./index-repo";
import { getLesson } from "./lessons";
import { dirOf, writeNote } from "./lessons-decide";

// The note a half-finished accept already wrote. The lesson id tag is unique to this lesson, and
// the directory pins the scope and project the accept path would have used, so a similar lesson
// note of the same task is never taken for it.
function existingNote(db: Database, lesson: LessonView) {
  const dir = `${dirOf(lesson)}/`;
  const row = db
    .query<NoteRow, [string, string, string, string]>(
      `SELECT * FROM notes WHERE org_id = ? AND type = 'lesson'
       AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)
       AND substr(disk, 1, length(?)) = ?`,
    )
    .get(lesson.orgId, `lesson-${lesson.id}`, dir, dir);
  return row === null ? undefined : toIndexed(row);
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
      const found = existingNote(db, lesson);
      const noteId = found?.id ?? (await writeNote(db, home, lesson, lesson.body));
      db.query("UPDATE lessons SET note_id = ? WHERE id = ? AND note_id IS NULL").run(noteId, id);
      console.error(`memory: ${found ? "linked" : "wrote"} the note of accepted lesson ${id}`);
    } catch (e) {
      console.error(`memory: could not finish accepted lesson ${id}: ${(e as Error).message}`);
    }
  }
}
