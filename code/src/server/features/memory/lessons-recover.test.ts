import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { startMemory } from "./api";
import { proposeLessons } from "./lessons";
import { decideLesson } from "./lessons-decide";
import { close, GOOD, type World, world } from "./lessons-test-kit";

let w: World;
afterEach(async () => {
  await close(w);
});

async function accepted() {
  w = world();
  const dev = w.agent("dev");
  const lead = w.agent("lead");
  const task = w.doneTask(dev);
  const [lesson] = await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: task.id }, [
    GOOD,
  ]);
  return { lead, id: lesson?.id as string };
}

const noteCount = () =>
  (w.db.query("SELECT count(*) AS n FROM notes WHERE type = 'lesson'").get() as { n: number }).n;
const noteIdOf = (id: string) =>
  (w.db.query("SELECT note_id FROM lessons WHERE id = ?").get(id) as { note_id: string | null })
    .note_id;

test("a lesson claimed as accepted without a note gets its note on the next start", async () => {
  const { lead, id } = await accepted();
  w.db
    .query("UPDATE lessons SET status = 'accepted', reviewer_id = ?, decided_at = 1 WHERE id = ?")
    .run(lead.id, id);
  expect(noteCount()).toBe(0);
  await startMemory(w.db, { home: w.home })();
  expect(noteCount()).toBe(1);
  expect(noteIdOf(id)).not.toBeNull();
});

test("a note written before the crash is linked, not written twice", async () => {
  const { lead, id } = await accepted();
  await decideLesson(w.db, w.home, id, { memberId: lead.id, userId: null }, "accept", "ok");
  w.db.query("UPDATE lessons SET note_id = NULL WHERE id = ?").run(id);
  await startMemory(w.db, { home: w.home })();
  expect(noteCount()).toBe(1);
  expect(noteIdOf(id)).not.toBeNull();
});
