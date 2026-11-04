import { z } from "zod";

export type NoteScope = "global" | "org" | "project" | "agent";
export type NoteType = "lesson" | "fact" | "decision" | "howto" | "reference";
export type NoteWriteOp = "create" | "update" | "delete" | "rename" | "revert" | "outside";
export type LessonStatus = "pending" | "accepted" | "rejected";

const noteScopeSchema: z.ZodType<NoteScope> = z.enum(["global", "org", "project", "agent"]);
const noteTypeSchema: z.ZodType<NoteType> = z.enum([
  "lesson",
  "fact",
  "decision",
  "howto",
  "reference",
]);

export interface NoteSummary {
  id: string;
  path: string;
  scope: NoteScope;
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
  type: NoteType;
  title: string;
  tags: string[];
  sourceAgent: string;
  confidence: number;
  created: string;
  updated: string;
  hash: string;
  snippet?: string | undefined;
}

export interface NoteView extends Omit<NoteSummary, "snippet"> {
  body: string;
  // Whether the viewer may edit this note; computed by the server so the UI does not guess from scopes.
  canWrite: boolean;
}

const noteFields = {
  id: z.string(),
  path: z.string(),
  scope: noteScopeSchema,
  orgId: z.string().nullable(),
  projectId: z.string().nullable(),
  memberId: z.string().nullable(),
  type: noteTypeSchema,
  title: z.string(),
  tags: z.array(z.string()),
  sourceAgent: z.string(),
  confidence: z.number().min(0).max(1),
  created: z.string(),
  updated: z.string(),
  hash: z.string(),
};

export const noteSummarySchema: z.ZodType<NoteSummary> = z.object({
  ...noteFields,
  snippet: z.string().optional(),
});
export const noteViewSchema: z.ZodType<NoteView> = z.object({
  ...noteFields,
  body: z.string(),
  canWrite: z.boolean(),
});

export interface NoteWriteView {
  id: string;
  noteId: string;
  path: string;
  op: NoteWriteOp;
  actor: string;
  runId: string | null;
  at: number;
  beforeHash: string | null;
  afterHash: string | null;
}

export const noteWriteViewSchema: z.ZodType<NoteWriteView> = z.object({
  id: z.string(),
  noteId: z.string(),
  path: z.string(),
  op: z.enum(["create", "update", "delete", "rename", "revert", "outside"]),
  actor: z.string(),
  runId: z.string().nullable(),
  at: z.number(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
});

// The feed row: the server decides canRevert (rename and outside edits cannot be undone, and the
// viewer needs write access to the note's location) so the web never has to guess.
export interface NoteWriteFeedItem extends NoteWriteView {
  before: string | null;
  after: string | null;
  canRevert: boolean;
}
export const noteWriteFeedItemSchema: z.ZodType<NoteWriteFeedItem> = z.intersection(
  noteWriteViewSchema,
  z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    canRevert: z.boolean(),
  }),
);

export interface LessonView {
  id: string;
  taskId: string;
  orgId: string;
  projectId: string | null;
  // Null once the author's member row is removed; authorHandle still says who wrote it.
  authorId: string | null;
  authorHandle: string;
  body: string;
  scope: NoteScope;
  type: NoteType;
  status: LessonStatus;
  reviewerId: string | null;
  reason: string | null;
  noteId: string | null;
  createdAt: number;
  decidedAt: number | null;
  // Filled by the list route so the review page can deep-link; null when the task is gone.
  task?: { number: number; projectId: string; title: string } | null | undefined;
}

export const lessonViewSchema: z.ZodType<LessonView> = z.object({
  id: z.string(),
  taskId: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  authorId: z.string().nullable(),
  authorHandle: z.string(),
  body: z.string(),
  scope: noteScopeSchema,
  type: noteTypeSchema,
  status: z.enum(["pending", "accepted", "rejected"]),
  reviewerId: z.string().nullable(),
  reason: z.string().nullable(),
  noteId: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  task: z
    .object({ number: z.number(), projectId: z.string(), title: z.string() })
    .nullable()
    .optional(),
});
