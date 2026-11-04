import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { moveTask } from "../board/api";
import { proposeLessons } from "./lessons";
import { close, GOOD, manage, type World, world } from "./lessons-test-kit";
import { startRetro } from "./retro";

let w: World;
let stop: () => void = () => {};
afterEach(async () => {
  stop();
  await close(w);
});

type Sent = { memberId: string; reason: string; detail: object; taskId: string | null };

// Stores a row like the real enqueue does, so the "no earlier retro" check has something to see.
function watch(): Sent[] {
  const sent: Sent[] = [];
  stop = startRetro(w.db, {
    enqueueWake: (memberId, reason, detail, taskId) => {
      sent.push({ memberId, reason, detail, taskId });
      w.db
        .query(
          "INSERT INTO wakeups (id, member_id, reason, task_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', 1)",
        )
        .run(Bun.randomUUIDv7(), memberId, reason, taskId);
    },
  });
  return sent;
}

test("a task moved to done wakes its agent assignee once with a retro", () => {
  w = world();
  const dev = w.agent("dev");
  const sent = watch();
  const task = w.task("ship it", dev);
  moveTask(w.db, task.id, "done", w.human.id);
  expect(sent).toEqual([
    {
      memberId: dev.id,
      reason: "retro",
      detail: { taskId: task.id, number: task.number, title: "ship it" },
      taskId: task.id,
    },
  ]);
  moveTask(w.db, task.id, "in_progress", w.human.id);
  moveTask(w.db, task.id, "done", w.human.id);
  expect(sent.length).toBe(1);
});

test("a human assignee, no assignee and a paused agent get no retro", () => {
  w = world();
  const sent = watch();
  const human = w.task("by a person", w.agent("dev"));
  w.db.query("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(w.human.id, human.id);
  moveTask(w.db, human.id, "done", w.human.id);
  const nobody = w.task("unassigned", w.agent("x1"));
  w.db.query("UPDATE tasks SET assignee_id = NULL WHERE id = ?").run(nobody.id);
  moveTask(w.db, nobody.id, "done", w.human.id);
  const sleeper = w.agent("sleeper");
  const asleep = w.task("paused", sleeper);
  w.db.query("UPDATE members SET paused = 1 WHERE id = ?").run(sleeper.id);
  moveTask(w.db, asleep.id, "done", w.human.id);
  expect(sent).toEqual([]);
});

test("a proposal wakes the author's manager for lesson_review, one wake per batch", async () => {
  w = world();
  const dev = w.agent("dev");
  const lead = w.agent("lead");
  manage(w, lead, dev);
  const sent = watch();
  const task = w.doneTask(dev);
  const made = await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: task.id }, [
    GOOD,
    `${GOOD} Again.`,
  ]);
  expect(sent).toEqual([
    {
      memberId: lead.id,
      reason: "lesson_review",
      detail: { lessonIds: made.map((l) => l.id) },
      taskId: task.id,
    },
  ]);
});

test("with nobody to review, no lesson_review is queued", async () => {
  w = world();
  const dev = w.agent("dev");
  const sent = watch();
  await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: w.doneTask(dev).id }, [GOOD]);
  expect(sent).toEqual([]);
});

test("stopping removes both listeners", async () => {
  w = world();
  const dev = w.agent("dev");
  const sent = watch();
  stop();
  moveTask(w.db, w.task("t", dev).id, "done", w.human.id);
  await proposeLessons(w.db, { memberId: dev.id, runId: null, taskId: w.doneTask(dev).id }, [GOOD]);
  expect(sent).toEqual([]);
});
