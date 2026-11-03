import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTask, listTasks, moveTask } from "../board/api";
import { ensureProjectChannel, postMessage } from "../chat/api";
import {
  directReportsOf,
  listMembers,
  listPositions,
  listProjects,
  type MemberRow,
  managerPositionsOf,
  projectAccess,
  reportsTransitivelyTo,
} from "../orgs/api";
import { profileOfMember } from "../profiles/api";
import { defineTool, fail, type ToolCtx, type ToolEnv } from "./tools-kit";
import { task } from "./tools-refs";
import { recordPlannerEstimate } from "./tools-tracking";

// Viewers and paused agents cannot take work, so they are neither listed nor delegated to.
function reportsOf(ctx: ToolCtx): MemberRow[] {
  const mine = managerPositionsOf(ctx.db, ctx.memberId).map((p) => p.id);
  return listMembers(ctx.db, ctx.orgId).filter(
    (m) =>
      m.id !== ctx.memberId &&
      m.role !== "viewer" &&
      !(m.kind === "agent" && m.paused) &&
      mine.some((position) => reportsTransitivelyTo(ctx.db, m.id, position)),
  );
}

function openTasksOf(ctx: ToolCtx, memberId: string): number {
  return listProjects(ctx.db, ctx.orgId)
    .flatMap((p) => listTasks(ctx.db, p.id, { assigneeId: memberId }))
    .filter((t) => t.status !== "done" && t.status !== "cancelled").length;
}

function rosterEntry(
  env: ToolEnv,
  ctx: ToolCtx,
  m: MemberRow,
  direct: Set<string>,
): Record<string, unknown> {
  const profile = m.kind === "agent" ? profileOfMember(ctx.db, m.id) : null;
  return {
    handle: m.handle,
    position: listPositions(ctx.db, ctx.orgId)
      .filter((p) => p.memberId === m.id)
      .map((p) => p.title)
      .join(", "),
    direct: direct.has(m.id),
    runtime: profile?.runtime ?? m.agentId,
    model: profile?.model ?? m.model,
    summary: profile?.card?.summary ?? null,
    specialties: profile?.card?.specialties ?? m.specialties,
    openTasks: openTasksOf(ctx, m.id),
    budget: m.kind === "agent" ? env.tracking.budgetState(ctx.db, m.id) : null,
  };
}

function delegate(
  env: ToolEnv,
  ctx: ToolCtx,
  a: {
    task: number | string;
    to: string;
    title: string;
    description?: string | undefined;
    estimateMinutes?: number | undefined;
  },
): string {
  const parent = task(ctx, a.task, true);
  if (parent.status === "done" || parent.status === "cancelled") fail("the task is closed");
  const handle = a.to.replace(/^@/, "");
  const target = reportsOf(ctx).find((m) => m.handle === handle);
  if (!target) fail(`@${handle} is not one of your reports`);
  const access = projectAccess(ctx.db, { memberId: target.id }, parent.projectId);
  if (access !== "write" && access !== "admin") fail(`@${handle} cannot work on this project`);
  const created = createTask(ctx.db, {
    projectId: parent.projectId,
    title: a.title,
    createdBy: ctx.memberId,
    parentId: parent.id,
    assigneeId: target.id,
    ...(a.description === undefined ? {} : { description: a.description }),
  });
  recordPlannerEstimate(env, ctx, created.id, a.estimateMinutes);
  postMessage(ctx.db, {
    channelId: ensureProjectChannel(ctx.db, parent.projectId).id,
    authorId: ctx.memberId,
    body: `@${handle}: #${created.number} ${a.title}`,
  });
  const moved =
    parent.status === "in_progress"
      ? null
      : moveTask(ctx.db, parent.id, "in_progress", ctx.memberId);
  return moved && !moved.ok
    ? `#${created.number} (the parent stays ${parent.status}: ${moved.reason})`
    : `#${created.number}`;
}

export function registerManagerTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "team_roster",
      scope: "board",
      description:
        "Your direct and indirect reports: handle, position, runtime, model, card summary, specialties, open assigned tasks and budget state",
      shape: {},
    },
    (ctx) => {
      const direct = new Set(directReportsOf(ctx.db, ctx.memberId));
      return reportsOf(ctx).map((m) => rosterEntry(env, ctx, m, direct));
    },
  );
  defineTool(
    server,
    env,
    {
      name: "task_delegate",
      scope: "board",
      description:
        "Split off a subtask of a task and hand it to one of your reports; they are assigned and told in the project channel. Returns the subtask number",
      shape: {
        task: z.union([z.number().int(), z.string()]),
        to: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().max(20000).optional(),
        estimateMinutes: z.number().int().positive().optional(),
      },
    },
    (ctx, a) => delegate(env, ctx, a),
  );
}
