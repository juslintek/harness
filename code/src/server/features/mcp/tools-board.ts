import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Status, TaskView } from "../../../shared/board";
import {
  addComment,
  addDependency,
  checkoutTask,
  createTask,
  listTasks,
  type MoveResult,
  moveTask,
  releaseTask,
  type TaskPatch,
  taskDetail,
  updateTask,
} from "../board/api";
import { findMembersByHandle, projectAccess } from "../orgs/api";
import { defineMemberTool, fail, handleOf, type MemberCtx, type ToolEnv } from "./tools-kit";
import { canWrite, project, task, visibleProjects } from "./tools-refs";
import { recordPlannerEstimate } from "./tools-tracking";

const STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
const status = z.enum(STATUSES);
const taskRef = z.union([z.number().int(), z.string()]);
const DEFAULT_LISTED = 100;
const MAX_LISTED = 200;

function compact(db: Database, t: TaskView): Record<string, unknown> {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    assignee: handleOf(db, t.assigneeId),
    holder: handleOf(db, t.holderId),
    estimateMinutes: t.estimateMinutes,
  };
}

// A project can be worked by members of its owning org and of grantee orgs, so the handle is
// matched across orgs among members who may write to it.
function assigneeId(ctx: MemberCtx, handle: string | null, projectId: string): string | null {
  if (handle === null) return null;
  const known = findMembersByHandle(ctx.db, handle.replace(/^@/, ""));
  if (known.length === 0) fail(`no member @${handle}`);
  const writers = known.filter((m) => {
    const access = projectAccess(ctx.db, { memberId: m.id }, projectId);
    return access === "write" || access === "admin";
  });
  if (writers.length > 1) fail(`@${handle} matches more than one member, use a unique handle`);
  return writers[0]?.id ?? fail(`@${handle} cannot work on this project`);
}

function moved(ctx: MemberCtx, r: MoveResult): unknown {
  if (r.ok) return compact(ctx.db, r.task);
  if (r.reason === "held") return fail(`held by @${handleOf(ctx.db, r.holderId) ?? "unknown"}`);
  if (r.reason === "not_found") return fail("task not found or already closed");
  return fail(`${r.reason}: open tasks ${r.open.map((n) => `#${n}`).join(", ")}`);
}

function registerReads(server: McpServer, env: ToolEnv): void {
  defineMemberTool(
    server,
    env,
    {
      name: "board_list",
      scope: "board",
      description:
        "List tasks on the projects you can see; pass the returned next as cursor for the next page",
      shape: {
        project: z.string().optional(),
        status: status.optional(),
        mine: z.boolean().optional(),
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_LISTED).optional(),
      },
    },
    (ctx, a) => {
      const projects = a.project === undefined ? visibleProjects(ctx) : [project(ctx, a.project)];
      const filter = {
        ...(a.status === undefined ? {} : { status: a.status as Status }),
        ...(a.mine ? { assigneeId: ctx.memberId } : {}),
      };
      const all = projects.flatMap((p) => listTasks(ctx.db, p.id, filter));
      const from = a.cursor ?? 0;
      const to = from + (a.limit ?? DEFAULT_LISTED);
      return {
        tasks: all.slice(from, to).map((t) => compact(ctx.db, t)),
        ...(all.length > to ? { next: to } : {}),
      };
    },
  );
  defineMemberTool(
    server,
    env,
    {
      name: "task_get",
      scope: "board",
      description: "Show a task with deps, subtasks and comments",
      shape: { task: taskRef },
    },
    (ctx, a) => {
      const detail = taskDetail(ctx.db, task(ctx, a.task, false).id);
      return {
        ...compact(ctx.db, detail.task),
        ...env.tracking.taskFields(ctx.db, detail.task.id),
        description: detail.task.description,
        deps: detail.deps.map((t) => compact(ctx.db, t)),
        subtasks: detail.subtasks.map((t) => compact(ctx.db, t)),
        comments: detail.comments.map((c) => ({
          author: handleOf(ctx.db, c.authorId),
          body: c.body,
          created_at: c.createdAt,
        })),
      };
    },
  );
}

function updatePatch(
  ctx: MemberCtx,
  a: {
    title?: string | undefined;
    description?: string | undefined;
    estimateMinutes?: number | null | undefined;
    assignee?: string | null | undefined;
  },
  projectId: string,
): TaskPatch {
  return {
    ...(a.title === undefined ? {} : { title: a.title }),
    ...(a.description === undefined ? {} : { description: a.description }),
    ...(a.estimateMinutes === undefined ? {} : { estimateMinutes: a.estimateMinutes }),
    ...(a.assignee === undefined ? {} : { assigneeId: assigneeId(ctx, a.assignee, projectId) }),
  };
}

function registerWrites(server: McpServer, env: ToolEnv): void {
  defineMemberTool(
    server,
    env,
    {
      name: "task_create",
      scope: "board",
      description: "Create a task in a project",
      shape: {
        project: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().max(20000).optional(),
        parent: taskRef.optional(),
        assignee: z.string().optional(),
        estimateMinutes: z.number().int().positive().optional(),
      },
    },
    (ctx, a) => {
      const p = project(ctx, a.project);
      if (!canWrite(ctx, p.id)) fail("no write access to this project");
      const assignee = a.assignee === undefined ? null : assigneeId(ctx, a.assignee, p.id);
      const created = createTask(ctx.db, {
        projectId: p.id,
        title: a.title,
        createdBy: ctx.memberId,
        ...(a.description === undefined ? {} : { description: a.description }),
        ...(a.parent === undefined ? {} : { parentId: task(ctx, a.parent, true).id }),
        ...(assignee === null ? {} : { assigneeId: assignee }),
        ...(a.estimateMinutes === undefined ? {} : { estimateMinutes: a.estimateMinutes }),
      });
      recordPlannerEstimate(env, ctx, created.id, a.estimateMinutes);
      return compact(ctx.db, created);
    },
  );
  defineMemberTool(
    server,
    env,
    {
      name: "task_update",
      scope: "board",
      description: "Change a task's title, description, estimate or assignee (null unassigns)",
      shape: {
        task: taskRef,
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(20000).optional(),
        estimateMinutes: z.number().int().positive().nullable().optional(),
        assignee: z.union([z.string().min(1), z.null()]).optional(),
      },
    },
    (ctx, a) => {
      const t = task(ctx, a.task, true);
      const patch = updatePatch(ctx, a, t.projectId);
      return compact(ctx.db, updateTask(ctx.db, t.id, patch, ctx.memberId));
    },
  );
}

function registerClaim(server: McpServer, env: ToolEnv): void {
  defineMemberTool(
    server,
    env,
    {
      name: "task_checkout",
      scope: "board",
      description: "Take a task and start it",
      shape: { task: taskRef },
    },
    async (ctx, a) =>
      moved(ctx, await checkoutTask(ctx.db, task(ctx, a.task, true).id, ctx.memberId)),
  );
  defineMemberTool(
    server,
    env,
    {
      name: "task_release",
      scope: "board",
      description: "Give a task you hold back",
      shape: { task: taskRef },
    },
    async (ctx, a) =>
      moved(ctx, await releaseTask(ctx.db, task(ctx, a.task, true).id, ctx.memberId)),
  );
}

function registerFlow(server: McpServer, env: ToolEnv): void {
  defineMemberTool(
    server,
    env,
    {
      name: "task_move",
      scope: "board",
      description: "Move a task to another status",
      shape: { task: taskRef, to: status },
    },
    (ctx, a) => moved(ctx, moveTask(ctx.db, task(ctx, a.task, true).id, a.to, ctx.memberId)),
  );
  defineMemberTool(
    server,
    env,
    {
      name: "task_comment",
      scope: "board",
      description: "Comment on a task",
      shape: { task: taskRef, body: z.string().min(1).max(8000) },
    },
    (ctx, a) => {
      addComment(ctx.db, task(ctx, a.task, true).id, ctx.memberId, a.body);
      return "ok";
    },
  );
  defineMemberTool(
    server,
    env,
    {
      name: "task_depend",
      scope: "board",
      description: "Make a task depend on another task of the same project",
      shape: { task: taskRef, dependsOn: taskRef },
    },
    (ctx, a) => {
      addDependency(ctx.db, task(ctx, a.task, true).id, task(ctx, a.dependsOn, true).id);
      return "ok";
    },
  );
}

export function registerBoardTools(server: McpServer, env: ToolEnv): void {
  registerReads(server, env);
  registerWrites(server, env);
  registerClaim(server, env);
  registerFlow(server, env);
}
