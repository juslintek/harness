import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { startMemory } from "./api";
import { proposeLessons } from "./lessons";
import { decideLesson } from "./lessons-decide";
import { finishAcceptedLessons } from "./lessons-recover";
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

test("another lesson note of the same task is not taken for the unfinished one", async () => {
  w = world();
  const dev = w.agent("dev");
  const lead = w.agent("lead");
  const task = w.doneTask(dev);
  const [a, b] = await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: task.id }, [
    GOOD,
    "Pin the bun version in CI because a minor bump changed the test runner output.",
  ]);
  const by = { memberId: lead.id, userId: null };
  await decideLesson(w.db, w.home, a?.id as string, by, "accept", "ok");
  // Same task and same body, so only the lesson id tag can tell the two notes apart.
  w.db.query("UPDATE lessons SET body = ? WHERE id = ?").run(GOOD, b?.id as string);
  w.db
    .query("UPDATE lessons SET status = 'accepted', reviewer_id = ?, decided_at = 1 WHERE id = ?")
    .run(lead.id, b?.id as string);
  await startMemory(w.db, { home: w.home })();
  expect(noteCount()).toBe(2);
  expect(noteIdOf(b?.id as string)).not.toBe(noteIdOf(a?.id as string));
});

test("a failed note_id link keeps the lesson accepted and the next start links the same note", async () => {
  const { lead, id } = await accepted();
  w.db.run(
    "CREATE TRIGGER no_link BEFORE UPDATE OF note_id ON lessons BEGIN SELECT RAISE(ABORT, 'link failed'); END",
  );
  await expect(
    decideLesson(w.db, w.home, id, { memberId: lead.id, userId: null }, "accept", "ok"),
  ).rejects.toThrow("link failed");
  expect(w.db.query("SELECT status FROM lessons WHERE id = ?").get(id)).toEqual({
    status: "accepted",
  });
  expect(noteIdOf(id)).toBeNull();
  expect(noteCount()).toBe(1);
  w.db.run("DROP TRIGGER no_link");
  await finishAcceptedLessons(w.db, w.home);
  expect(noteIdOf(id)).not.toBeNull();
  expect(noteCount()).toBe(1);
});
