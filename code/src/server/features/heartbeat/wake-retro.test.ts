import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { moveTask } from "../board/api";
import { proposeLessons, reviewerFor } from "../memory/api";
import { setup, until, wakes } from "./kit";
import { buildPrompt } from "./prompt";
import { insertWake, pendingWakes } from "./repo";

setDefaultTimeout(30_000);

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  delete process.env.OLLAYA_URL;
});

test("a retro wake can be stored and described", () => {
  const k = setup();
  const dev = k.agent("dev");
  const task = k.task("shipped");
  insertWake(k.db, {
    memberId: dev.id,
    reason: "retro",
    taskId: task.id,
    detail: { taskId: task.id, number: task.number, title: "shipped" },
    causedBy: null,
  });
  const prompt = buildPrompt(k.db, dev, pendingWakes(k.db, dev.id));
  expect(prompt).toContain(`Task #${task.number} "shipped"`);
  expect(prompt).toContain("lesson_propose");
});

test("a task moved to done enqueues a retro wake, and a proposal a lesson_review wake", async () => {
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  const k = setup();
  const dev = k.agent("dev");
  const lead = k.agent("lead");
  const task = k.task("ship it");
  k.db.query("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(dev.id, task.id);
  // The lead shares the dev's team, which makes it the reviewer when no manager position exists.
  for (const m of [dev, lead]) {
    k.db.query("INSERT INTO team_members (team_id, member_id) SELECT id, ? FROM teams").run(m.id);
  }
  stops.push(k.start());
  moveTask(k.db, task.id, "done", k.human.id);
  await until(() => wakes(k.db, dev.id).some((w) => w.reason === "retro"));
  const [lesson] = await proposeLessons(k.db, { memberId: dev.id, runId: null, taskId: task.id }, [
    "Run the full check before pushing, the gate catches cycles late.",
  ]);
  expect(reviewerFor(k.db, lesson as NonNullable<typeof lesson>)).toBe(lead.id);
  await until(() => wakes(k.db, lead.id).some((w) => w.reason === "lesson_review"));
  expect(wakes(k.db, dev.id).filter((w) => w.reason === "retro").length).toBe(1);
});

test("a retro wake and an assignment wake for one member and project run apart", async () => {
  const k = setup();
  const dev = k.agent("dev");
  const work = k.task("build it");
  const shipped = k.task("shipped");
  k.db.query("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(dev.id, work.id);
  const wake = (reason: "assignment" | "retro", taskId: string): void =>
    insertWake(k.db, { memberId: dev.id, reason, taskId, detail: { taskId }, causedBy: null });
  wake("assignment", work.id);
  wake("retro", shipped.id);
  stops.push(k.start());
  await until(() => wakes(k.db, dev.id).every((w) => w.status === "done"));
  const runs = new Set(wakes(k.db, dev.id).map((w) => w.run_id));
  expect(runs.size).toBe(2);
  expect(k.seen.length).toBe(2);
});
