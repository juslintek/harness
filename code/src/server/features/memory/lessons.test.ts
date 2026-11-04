import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { moveTask } from "../board/api";
import { resetLayaCircuit } from "../laya/api";
import { updateMember } from "../orgs/api";
import { listLessons, onLessonProposed, proposeLessons, reviewerFor } from "./lessons";
import { close, GOOD, manage, mate, type World, world } from "./lessons-test-kit";

let w: World;
afterEach(async () => {
  await close(w);
});

const ctxOf = (memberId: string, taskId: string) => ({ memberId, runId: null, taskId });

test("a proposal for a task that is not done is refused", async () => {
  w = world();
  const dev = w.agent("dev");
  const open = w.task("open", dev);
  await expect(proposeLessons(w.db, ctxOf(dev.id, open.id), [GOOD])).rejects.toThrow("not done");
  moveTask(w.db, open.id, "done", w.human.id);
  expect((await proposeLessons(w.db, ctxOf(dev.id, open.id), [GOOD])).length).toBe(1);
});

test("only the assignee proposes, and not across orgs", async () => {
  w = world();
  const dev = w.agent("dev");
  const task = w.doneTask(dev);
  await expect(proposeLessons(w.db, ctxOf(w.agent("other").id, task.id), [GOOD])).rejects.toThrow(
    "not yours",
  );
  await expect(proposeLessons(w.db, ctxOf(w.other.agent.id, task.id), [GOOD])).rejects.toThrow(
    "no such task",
  );
});

test("1 to 3 bodies of 20 to 600 characters", async () => {
  w = world();
  const dev = w.agent("dev");
  const t = ctxOf(dev.id, w.doneTask(dev).id);
  await expect(proposeLessons(w.db, t, [])).rejects.toThrow("1 to 3");
  await expect(proposeLessons(w.db, t, [GOOD, GOOD, GOOD, GOOD])).rejects.toThrow("1 to 3");
  await expect(proposeLessons(w.db, t, ["too short"])).rejects.toThrow("20 to 600");
  await expect(proposeLessons(w.db, t, ["x".repeat(601)])).rejects.toThrow("20 to 600");
});

test("a secret in a lesson is redacted before the lessons table sees it", async () => {
  w = world();
  const dev = w.agent("dev");
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
  const [lesson] = await proposeLessons(w.db, ctxOf(dev.id, w.doneTask(dev).id), [
    `Deploy needs the key ${secret} exported before running the script`,
  ]);
  expect(lesson?.body).not.toContain(secret);
  const stored = w.db.query<{ body: string }, []>("SELECT body FROM lessons").all();
  expect(stored.every((r) => !r.body.includes(secret))).toBe(true);
});

test("the proposal is listed per org and per status, and announced", async () => {
  w = world();
  const dev = w.agent("dev");
  const seen: number[] = [];
  const off = onLessonProposed((e) => seen.push(e.lessons.length));
  await proposeLessons(w.db, ctxOf(dev.id, w.doneTask(dev).id), [GOOD, `${GOOD} Twice.`]);
  off();
  expect(seen).toEqual([2]);
  expect(listLessons(w.db, w.orgId, "pending").length).toBe(2);
  expect(listLessons(w.db, w.orgId, "accepted")).toEqual([]);
  expect(listLessons(w.db, w.other.orgId)).toEqual([]);
});

test("reviewerFor prefers the manager, then a teammate, never the author, null for none", async () => {
  w = world();
  const dev = w.agent("dev");
  const lesson = { authorId: dev.id, orgId: w.orgId };
  expect(reviewerFor(w.db, lesson)).toBeNull();
  const peer = w.agent("peer");
  mate(w, dev, peer);
  expect(reviewerFor(w.db, lesson)).toBe(peer.id);
  const lead = w.agent("lead");
  manage(w, lead, dev);
  expect(reviewerFor(w.db, lesson)).toBe(lead.id);
  updateMember(w.db, lead.id, { paused: true });
  expect(reviewerFor(w.db, lesson)).toBe(peer.id);
});

test("reviewerFor skips viewer agents, since heartbeat refuses to run them", () => {
  w = world();
  const dev = w.agent("dev");
  const peer = w.agent("peer");
  const lead = w.agent("lead");
  mate(w, dev, peer);
  manage(w, lead, dev);
  updateMember(w.db, lead.id, { role: "viewer" });
  expect(reviewerFor(w.db, { authorId: dev.id, orgId: w.orgId })).toBe(peer.id);
  updateMember(w.db, peer.id, { role: "viewer" });
  expect(reviewerFor(w.db, { authorId: dev.id, orgId: w.orgId })).toBeNull();
});

test("the 1 to 3 cap holds per task and author, also for two racing calls", async () => {
  w = world();
  const dev = w.agent("dev");
  const t = ctxOf(dev.id, w.doneTask(dev).id);
  await proposeLessons(w.db, t, [GOOD]);
  await expect(proposeLessons(w.db, t, [`${GOOD} Again.`])).rejects.toMatchObject({
    code: "conflict",
  });
  const other = ctxOf(dev.id, w.doneTask(dev, "second").id);
  const seen: number[] = [];
  const off = onLessonProposed((e) => seen.push(e.lessons.length));
  const res = await Promise.allSettled([
    proposeLessons(w.db, other, [GOOD]),
    proposeLessons(w.db, other, [`${GOOD} Racing.`]),
  ]);
  off();
  expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect(seen).toEqual([1]);
  expect(listLessons(w.db, w.orgId).length).toBe(2);
});

test("a member demoted to viewer while the classifier runs proposes nothing", async () => {
  w = world();
  const dev = w.agent("dev");
  const task = w.doneTask(dev);
  const classifier = Bun.serve({
    port: 0,
    fetch: () => {
      updateMember(w.db, dev.id, { role: "viewer" });
      return new Response("busy", { status: 503 });
    },
  });
  process.env.OLLAYA_URL = `http://127.0.0.1:${classifier.port}`;
  resetLayaCircuit();
  try {
    await expect(proposeLessons(w.db, ctxOf(dev.id, task.id), [GOOD])).rejects.toThrow(
      "not allowed",
    );
  } finally {
    await classifier.stop(true);
  }
  expect(listLessons(w.db, w.orgId)).toEqual([]);
});
