import "../../test-support/no-git-env";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LessonView } from "../../../shared/memory";
import { createProject, removeMember, updateMember } from "../orgs/api";
import { searchNotes } from "./index-search";
import { getLesson, onLessonDecided, proposeLessons, reviewerFor } from "./lessons";
import { decideLesson } from "./lessons-decide";
import { close, GOOD, type World, world } from "./lessons-test-kit";
import { MemoryError } from "./store-kit";
import { agentViewer } from "./viewer";

let w: World;
afterEach(async () => {
  await close(w);
});

async function pending(count = 1) {
  const dev = w.agent("dev");
  const task = w.doneTask(dev);
  const bodies = [GOOD, `${GOOD} Second.`, `${GOOD} Third.`].slice(0, count);
  const lessons = await proposeLessons(
    w.db,
    { memberId: dev.id, runId: null, taskId: task.id },
    bodies,
  );
  return { dev, task, lessons };
}

const asAgent = (memberId: string) => ({ memberId, userId: null });

test("accepting writes a lesson note found by search for the same org, and announces it", async () => {
  w = world();
  const { dev, lessons } = await pending();
  const seen: string[] = [];
  const off = onLessonDecided((l) => seen.push(l.status));
  const lead = w.agent("lead");
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "accept",
    "useful",
  );
  off();
  expect(seen).toEqual(["accepted"]);
  expect(out).toMatchObject({ status: "accepted", reviewerId: lead.id, reason: "useful" });
  expect(out.noteId).not.toBeNull();
  const hits = searchNotes(w.db, agentViewer(w.db, lead.id), { type: "lesson" });
  const hit = hits.find((n) => n.id === out.noteId);
  expect(hit).toMatchObject({ type: "lesson", sourceAgent: "dev" });
  expect(hit?.path).toContain(
    `/projects/${w.projectId}/lessons/run-bun-run-check-before-pushing.md`,
  );
  expect(hit?.tags).toEqual(["lesson", `task-${1}`, `lesson-${lessons[0]?.id}`]);
  expect(existsSync(join(w.home, "memory", hit?.path as string))).toBe(true);
  expect(dev.id).not.toBe(lead.id);
});

test("an edited body replaces the original, redacted and length checked", async () => {
  w = world();
  const { lessons } = await pending();
  const lead = w.agent("lead");
  await expect(
    decideLesson(w.db, w.home, lessons[0]?.id as string, asAgent(lead.id), "accept", "ok", "short"),
  ).rejects.toThrow("20 to 600");
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "accept",
    "ok",
    "Always run the full check before pushing, the gate catches cycles late.",
  );
  expect(out.body).toContain("full check");
});

test("a rejection stores the reason and writes no note", async () => {
  w = world();
  const { lessons } = await pending();
  const lead = w.agent("lead");
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "reject",
    "vague",
  );
  expect(out).toMatchObject({ status: "rejected", reason: "vague", noteId: null });
});

test("the author cannot review their own lesson", async () => {
  w = world();
  const { dev, lessons } = await pending();
  await expect(
    decideLesson(w.db, w.home, lessons[0]?.id as string, asAgent(dev.id), "accept", "mine"),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("an agent of another org cannot review, and the lesson stays pending", async () => {
  w = world();
  const { lessons } = await pending();
  await expect(
    decideLesson(w.db, w.home, lessons[0]?.id as string, asAgent(w.other.agent.id), "accept", "x"),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    decideLesson(
      w.db,
      w.home,
      lessons[0]?.id as string,
      { memberId: null, userId: null },
      "accept",
      "x",
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(w.db.query("SELECT status FROM lessons").get()).toEqual({ status: "pending" });
});

test("a person of the org reviews through their user id", async () => {
  w = world();
  const { lessons } = await pending();
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    { memberId: null, userId: "u-acme" },
    "accept",
    "good",
  );
  expect(out.reviewerId).toBe(w.human.id);
});

test("two concurrent decisions make exactly one note, the other is already decided", async () => {
  w = world();
  const { lessons } = await pending();
  const a = w.agent("lead");
  const b = w.agent("peer");
  const id = lessons[0]?.id as string;
  const results = await Promise.allSettled([
    decideLesson(w.db, w.home, id, asAgent(a.id), "accept", "one"),
    decideLesson(w.db, w.home, id, asAgent(b.id), "accept", "two"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(lost.reason).toBeInstanceOf(MemoryError);
  expect(lost.reason).toMatchObject({ code: "conflict", message: "already decided" });
  const notes = searchNotes(w.db, agentViewer(w.db, a.id), { type: "lesson" });
  expect(notes.length).toBe(1);
});

test("a failed note write puts the lesson back to pending instead of accepted without a note", async () => {
  w = world();
  const { lessons } = await pending();
  const lead = w.agent("lead");
  const id = lessons[0]?.id as string;
  // A project the author cannot reach makes the note write fail after the status was claimed.
  const foreign = createProject(w.db, { orgId: w.other.orgId, key: "api", name: "Api" });
  w.db
    .query("UPDATE lessons SET project_id = ?, scope = 'project' WHERE id = ?")
    .run(foreign.id, id);
  await expect(
    decideLesson(w.db, w.home, id, asAgent(lead.id), "accept", "ok"),
  ).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(w.db.query("SELECT status, reviewer_id, note_id, decided_at FROM lessons").get()).toEqual({
    status: "pending",
    reviewer_id: null,
    note_id: null,
    decided_at: null,
  });
  w.db.query("UPDATE lessons SET project_id = ? WHERE id = ?").run(w.projectId, id);
  const out = await decideLesson(w.db, w.home, id, asAgent(lead.id), "accept", "ok");
  expect(out.status).toBe("accepted");
});

test("lessons with the same opening words get a numbered path", async () => {
  w = world();
  const { lessons } = await pending(2);
  const lead = w.agent("lead");
  const first = lessons[0]?.id as string;
  const second = lessons[1]?.id as string;
  w.db.query("UPDATE lessons SET body = ? WHERE id = ?").run(GOOD, second);
  await decideLesson(w.db, w.home, first, asAgent(lead.id), "accept", "a");
  await decideLesson(w.db, w.home, second, asAgent(lead.id), "accept", "b");
  const paths = searchNotes(w.db, agentViewer(w.db, lead.id), { type: "lesson" }).map(
    (n) => n.path,
  );
  expect(paths.some((p) => p.endsWith("-2.md"))).toBe(true);
});

test("a demoted author's lesson is still written when a reviewer accepts it, sourced to the author", async () => {
  w = world();
  const { dev, lessons } = await pending();
  const lead = w.agent("lead");
  updateMember(w.db, dev.id, { role: "viewer" });
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "accept",
    "still good",
  );
  const hit = searchNotes(w.db, agentViewer(w.db, lead.id), { type: "lesson" }).find(
    (n) => n.id === out.noteId,
  );
  expect(hit).toMatchObject({ sourceAgent: "dev" });
});

test("removing the author keeps the accepted lesson with its reviewer, reason, note and handle", async () => {
  w = world();
  const { dev, lessons } = await pending();
  const lead = w.agent("lead");
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "accept",
    "useful",
  );
  removeMember(w.db, dev.id);
  const kept = getLesson(w.db, out.id);
  expect(kept).toMatchObject({
    status: "accepted",
    authorId: null,
    authorHandle: "dev",
    reviewerId: lead.id,
    reason: "useful",
    noteId: out.noteId,
  });
  expect(reviewerFor(w.db, kept as LessonView)).toBeNull();
});

test("a lesson without an author can still be reviewed by anyone else, but not written as an agent note", async () => {
  w = world();
  const { dev, lessons } = await pending();
  removeMember(w.db, dev.id);
  const lead = w.agent("lead");
  await expect(
    decideLesson(w.db, w.home, lessons[0]?.id as string, asAgent(lead.id), "accept", "ok"),
  ).rejects.toThrow("author is gone");
  const out = await decideLesson(
    w.db,
    w.home,
    lessons[0]?.id as string,
    asAgent(lead.id),
    "reject",
    "no",
  );
  expect(out).toMatchObject({ status: "rejected", authorId: null, authorHandle: "dev" });
});
