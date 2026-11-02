import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Status, TaskView } from "../../../shared/board";
import {
  addComment,
  addDependency,
  checkout,
  createTask,
  getTask,
  getTaskByNumber,
  listTasks,
  type MoveResult,
  moveTask,
  release,
  taskDetail,
  updateTask,
} from "../board/api";
import { findMemberByHandle, listProjects, type ProjectRow, projectAccess } from "../orgs/api";
import { defineTool, fail, handleOf, type ToolCtx, type ToolEnv } from "./tools-kit";

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
const MAX_LISTED = 100;

function visibleProjects(ctx: ToolCtx): ProjectRow[] {
  return listProjects(ctx.db, ctx.orgId).filter(
    (p) => projectAccess(ctx.db, { memberId: ctx.memberId }, p.id) !== "none",
  );
}

function project(ctx: ToolCtx, ref: string): ProjectRow {
  const hit = visibleProjects(ctx).find((p) => p.id === ref || p.key === ref);
  return hit ?? fail(`project not found: ${ref}`);
}

function canWrite(ctx: ToolCtx, projectId: string): boolean {
  const access = projectAccess(ctx.db, { memberId: ctx.memberId }, projectId);
  return access === "write" || access === "admin";
}

// Numbers are per org; an id may also name a task of a project another org granted us.
function task(ctx: ToolCtx, ref: number | string, write: boolean): TaskView {
  const found =
    typeof ref === "number" || /^\d+$/.test(ref)
      ? getTaskByNumber(ctx.db, ctx.orgId, Number(ref))
      : getTask(ctx.db, ref);
  const ok =
    found &&
    (write
      ? canWrite(ctx, found.projectId)
      : projectAccess(ctx.db, { memberId: ctx.memberId }, found.projectId) !== "none");
  return ok ? found : fail(`task not found: ${ref}`);
}

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

function assigneeId(ctx: ToolCtx, handle: string | null): string | null {
  if (handle === null) return null;
  return (
    findMemberByHandle(ctx.db, ctx.orgId, handle.replace(/^@/, ""))?.id ??
    fail(`no member @${handle}`)
  );
}

function moved(ctx: ToolCtx, r: MoveResult): unknown {
  if (r.ok) return compact(ctx.db, r.task);
  if (r.reason === "held") return fail(`held by @${handleOf(ctx.db, r.holderId) ?? "unknown"}`);
  if (r.reason === "not_found") return fail("task not found or already closed");
  return fail(`${r.reason}: open tasks ${r.open.map((n) => `#${n}`).join(", ")}`);
}

function registerReads(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "board_list",
      scope: "board",
      description: "List tasks on the projects you can see",
      shape: {
        project: z.string().optional(),
        status: status.optional(),
        mine: z.boolean().optional(),
      },
    },
    (ctx, a) => {
      const projects = a.project === undefined ? visibleProjects(ctx) : [project(ctx, a.project)];
      const filter = {
        ...(a.status === undefined ? {} : { status: a.status as Status }),
        ...(a.mine ? { assigneeId: ctx.memberId } : {}),
      };
      return projects
        .flatMap((p) => listTasks(ctx.db, p.id, filter))
        .slice(0, MAX_LISTED)
        .map((t) => compact(ctx.db, t));
    },
  );
  defineTool(
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

function registerWrites(server: McpServer, env: ToolEnv): void {
  defineTool(
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
      const assignee = a.assignee === undefined ? null : assigneeId(ctx, a.assignee);
      return compact(
        ctx.db,
        createTask(ctx.db, {
          projectId: p.id,
          title: a.title,
          createdBy: ctx.memberId,
          ...(a.description === undefined ? {} : { description: a.description }),
          ...(a.parent === undefined ? {} : { parentId: task(ctx, a.parent, true).id }),
          ...(assignee === null ? {} : { assigneeId: assignee }),
          ...(a.estimateMinutes === undefined ? {} : { estimateMinutes: a.estimateMinutes }),
        }),
      );
    },
  );
  defineTool(
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
        assignee: z.string().nullable().optional(),
      },
    },
    (ctx, a) => {
      const t = task(ctx, a.task, true);
      const patch = {
        ...(a.title === undefined ? {} : { title: a.title }),
        ...(a.description === undefined ? {} : { description: a.description }),
        ...(a.estimateMinutes === undefined ? {} : { estimateMinutes: a.estimateMinutes }),
        ...(a.assignee === undefined ? {} : { assigneeId: assigneeId(ctx, a.assignee) }),
      };
      return compact(ctx.db, updateTask(ctx.db, t.id, patch, ctx.memberId));
    },
  );
}

function registerFlow(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "task_checkout",
      scope: "board",
      description: "Take a task and start it",
      shape: { task: taskRef },
    },
    (ctx, a) => moved(ctx, checkout(ctx.db, task(ctx, a.task, true).id, ctx.memberId)),
  );
  defineTool(
    server,
    env,
    {
      name: "task_release",
      scope: "board",
      description: "Give a task you hold back",
      shape: { task: taskRef },
    },
    (ctx, a) => moved(ctx, release(ctx.db, task(ctx, a.task, true).id, ctx.memberId)),
  );
  defineTool(
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
  defineTool(
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
  defineTool(
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
  registerFlow(server, env);
}
