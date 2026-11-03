import { z } from "zod";
import { type PersonRef, personRefSchema } from "./people";

export type Status =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

const statusSchema: z.ZodType<Status> = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);

export interface TaskView {
  id: string;
  orgId: string;
  projectId: string;
  number: number;
  parentId: string | null;
  title: string;
  description: string;
  status: Status;
  rank: number;
  assigneeId: string | null;
  holderId: string | null;
  assignee: PersonRef | null;
  holder: PersonRef | null;
  checkedOutAt: number | null;
  estimateMinutes: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentView {
  id: string;
  taskId: string;
  authorId: string | null;
  author: PersonRef | null;
  body: string;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskView;
  deps: TaskView[];
  subtasks: TaskView[];
  comments: CommentView[];
}

export const taskViewSchema: z.ZodType<TaskView> = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  number: z.number(),
  parentId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: statusSchema,
  rank: z.number(),
  assigneeId: z.string().nullable(),
  holderId: z.string().nullable(),
  assignee: personRefSchema.nullable(),
  holder: personRefSchema.nullable(),
  checkedOutAt: z.number().nullable(),
  estimateMinutes: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const taskDetailSchema: z.ZodType<TaskDetail> = z.object({
  task: taskViewSchema,
  deps: z.array(taskViewSchema),
  subtasks: z.array(taskViewSchema),
  comments: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      authorId: z.string().nullable(),
      author: personRefSchema.nullable(),
      body: z.string(),
      createdAt: z.number(),
    }),
  ),
});

export type MoveFailure =
  | { ok: false; reason: "held"; holderId: string }
  | { ok: false; reason: "deps_open" | "children_open"; open: number[] }
  | { ok: false; reason: "not_found" };

export const moveFailureSchema: z.ZodType<MoveFailure> = z.union([
  z.object({ ok: z.literal(false), reason: z.literal("held"), holderId: z.string() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["deps_open", "children_open"]),
    open: z.array(z.number()),
  }),
  z.object({ ok: z.literal(false), reason: z.literal("not_found") }),
]);

const id = z.string().min(1).max(64);
const title = z.string().trim().min(1).max(200);

export interface CreateTaskBody {
  title: string;
  description?: string | undefined;
  parentId?: string | undefined;
  assigneeId?: string | undefined;
  estimateMinutes?: number | undefined;
  status?: Status | undefined;
}
export const createTaskBody: z.ZodType<CreateTaskBody> = z
  .object({
    title,
    description: z.string().max(20000).optional(),
    parentId: id.optional(),
    assigneeId: id.optional(),
    estimateMinutes: z.number().int().min(0).max(525600).optional(),
    status: statusSchema.optional(),
  })
  .strict();

export interface TaskPatchBody {
  title?: string | undefined;
  description?: string | undefined;
  estimateMinutes?: number | null | undefined;
  assigneeId?: string | null | undefined;
}
export const taskPatchBody: z.ZodType<TaskPatchBody> = z
  .object({
    title: title.optional(),
    description: z.string().max(20000).optional(),
    estimateMinutes: z.number().int().min(0).max(525600).nullable().optional(),
    assigneeId: id.nullable().optional(),
  })
  .strict();

export interface MoveBody {
  to: Status;
  beforeId?: string | undefined;
}
export const moveBody: z.ZodType<MoveBody> = z
  .object({ to: statusSchema, beforeId: id.optional() })
  .strict();

export interface DepBody {
  dependsOn: string;
}
export const depBody: z.ZodType<DepBody> = z.object({ dependsOn: id }).strict();

export interface CommentBody {
  body: string;
}
export const commentBody: z.ZodType<CommentBody> = z
  .object({ body: z.string().min(1).max(8000) })
  .strict();

export interface TaskListQuery {
  status?: Status | undefined;
  assigneeId?: string | undefined;
}
export const taskListQuery: z.ZodType<TaskListQuery> = z
  .object({ status: statusSchema.optional(), assigneeId: id.optional() })
  .strict();

export interface ProjectMemberView {
  id: string;
  handle: string;
  displayName: string;
  kind: "human" | "agent";
  orgName: string;
}
export const projectMemberSchema: z.ZodType<ProjectMemberView> = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  kind: z.enum(["human", "agent"]),
  orgName: z.string(),
});
