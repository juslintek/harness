import { expect, test } from "bun:test";
import {
  type LessonStatus,
  type LessonView,
  lessonViewSchema,
  type NoteScope,
  type NoteSummary,
  type NoteType,
  type NoteView,
  type NoteWriteOp,
  type NoteWriteView,
  noteSummarySchema,
  noteViewSchema,
  noteWriteViewSchema,
} from "./memory";

const scope: NoteScope = "agent";
const type: NoteType = "lesson";
const op: NoteWriteOp = "create";
const status: LessonStatus = "pending";

const summary: NoteSummary = {
  id: "n1",
  path: "orgs/o1/agents/m1/a.md",
  scope,
  orgId: "o1",
  projectId: null,
  memberId: "m1",
  type,
  title: "a",
  tags: ["x"],
  sourceAgent: "dev",
  confidence: 0.5,
  created: "2026-11-04T00:00:00.000Z",
  updated: "2026-11-04T00:00:00.000Z",
  hash: "h",
};

test("the memory schemas accept their views and reject a bad confidence", () => {
  const view: NoteView = { ...summary, body: "text" };
  expect(noteSummarySchema.parse(summary)).toEqual(summary);
  expect(noteViewSchema.parse(view)).toEqual(view);
  expect(noteViewSchema.safeParse({ ...view, confidence: 2 }).success).toBe(false);
  const write: NoteWriteView = {
    id: "w1",
    noteId: "n1",
    path: summary.path,
    op,
    actor: "dev",
    runId: null,
    at: 1,
    beforeHash: null,
    afterHash: "h",
  };
  expect(noteWriteViewSchema.parse(write)).toEqual(write);
  const lesson: LessonView = {
    id: "l1",
    taskId: "t1",
    orgId: "o1",
    projectId: null,
    authorId: "m1",
    body: "b",
    scope,
    type,
    status,
    reviewerId: null,
    reason: null,
    noteId: null,
    createdAt: 1,
    decidedAt: null,
  };
  expect(lessonViewSchema.parse(lesson)).toEqual(lesson);
});
