import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import { listLessons, onLessonDecided, onLessonProposed, startMemory } from "../memory/api";
import { call, type Db, listen, tokenFor, type World, world } from "./test-kit";

let db: Db;
let home: string;
let stop: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let w: World;

beforeEach(async () => {
  process.env.OLLAYA_URL = "http://127.0.0.1:1";
  db = openDb(":memory:");
  migrate(db, migrations);
  home = mkdtempSync(join(tmpdir(), "harness-lessontool-"));
  stop = startMemory(db, { home });
  server = await listen(db, home);
  w = world(db);
});
afterEach(async () => {
  delete process.env.OLLAYA_URL;
  server.stop(true);
  await stop();
  rmSync(home, { recursive: true, force: true });
});

const tokenOf = (memberId: string, orgId: string, scopes: ("memory" | "report")[] = ["memory"]) =>
  tokenFor(db, memberId, orgId, scopes);

const LESSON = "Run the full check before pushing, the gate catches cycles late.";

function doneTask(assigneeId: string) {
  const human = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ? AND kind = 'human'")
    .get(w.a.id) as { id: string };
  return createTask(db, {
    projectId: w.project.id,
    title: "Fix login",
    createdBy: human.id,
    assigneeId,
    status: "done",
  });
}

test("lesson_propose then lesson_review by a teammate accepts into a note", async () => {
  const dev = w.agent(w.a.id, "dev");
  const lead = w.agent(w.a.id, "lead");
  const task = doneTask(dev.id);
  const events: string[] = [];
  const offs = [
    onLessonProposed((e) => events.push(`proposed ${e.lessons.length}`)),
    onLessonDecided((l) => events.push(l.status)),
  ];
  const proposed = await call(server, tokenOf(dev.id, w.a.id), "lesson_propose", {
    taskId: task.id,
    lessons: [LESSON],
  });
  expect(proposed.isError).toBe(false);
  const lesson = listLessons(db, w.a.id, "pending")[0];
  expect(proposed.text).toContain(lesson?.id as string);
  const own = await call(server, tokenOf(dev.id, w.a.id), "lesson_review", {
    lessonId: lesson?.id,
    decision: "accept",
    reason: "mine",
  });
  expect(own.isError).toBe(true);
  expect(own.text).toContain("cannot review");
  const ok = await call(server, tokenOf(lead.id, w.a.id), "lesson_review", {
    lessonId: lesson?.id,
    decision: "accept",
    reason: "correct and specific",
  });
  expect(ok).toEqual({ isError: false, text: `accepted lesson ${lesson?.id}` });
  const twice = await call(server, tokenOf(lead.id, w.a.id), "lesson_review", {
    lessonId: lesson?.id,
    decision: "reject",
    reason: "again",
  });
  expect(twice).toEqual({ isError: true, text: "already decided" });
  for (const off of offs) off();
  expect(events).toEqual(["proposed 1", "accepted"]);
});

test("another org's agent cannot review, and a token without memory scope is refused", async () => {
  const dev = w.agent(w.a.id, "dev");
  const outsider = w.agent(w.b.id, "outsider");
  const task = doneTask(dev.id);
  await call(server, tokenOf(dev.id, w.a.id), "lesson_propose", {
    taskId: task.id,
    lessons: [LESSON],
  });
  const lesson = listLessons(db, w.a.id, "pending")[0];
  const res = await call(server, tokenOf(outsider.id, w.b.id), "lesson_review", {
    lessonId: lesson?.id,
    decision: "accept",
    reason: "x",
  });
  expect(res.isError).toBe(true);
  expect(res.text).toContain("cannot review");
  const noScope = await call(server, tokenOf(dev.id, w.a.id, ["report"]), "lesson_propose", {
    taskId: task.id,
    lessons: [LESSON],
  });
  expect(noScope).toEqual({ isError: true, text: "token lacks memory scope" });
});

test("a proposal for a task that is not yours or not done is a readable error", async () => {
  const dev = w.agent(w.a.id, "dev");
  const other = w.agent(w.a.id, "other");
  const task = doneTask(dev.id);
  const stranger = await call(server, tokenOf(other.id, w.a.id), "lesson_propose", {
    taskId: task.id,
    lessons: [LESSON],
  });
  expect(stranger).toEqual({ isError: true, text: "the task is not yours" });
});
