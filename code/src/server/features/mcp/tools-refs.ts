import type { TaskView } from "../../../shared/board";
import { getTask, getTaskByNumber } from "../board/api";
import { listProjects, type ProjectRow, projectAccess } from "../orgs/api";
import { fail, type ToolCtx } from "./tools-kit";

export function visibleProjects(ctx: ToolCtx): ProjectRow[] {
  return listProjects(ctx.db, ctx.orgId).filter(
    (p) => projectAccess(ctx.db, { memberId: ctx.memberId }, p.id) !== "none",
  );
}

export function project(ctx: ToolCtx, ref: string): ProjectRow {
  const hit = visibleProjects(ctx).find((p) => p.id === ref || p.key === ref);
  return hit ?? fail(`project not found: ${ref}`);
}

export function canWrite(ctx: ToolCtx, projectId: string): boolean {
  const access = projectAccess(ctx.db, { memberId: ctx.memberId }, projectId);
  return access === "write" || access === "admin";
}

// Numbers are per org. Your own org wins; otherwise a number may name a task of a project another
// org granted us, as long as exactly one such task matches. An id always names one task.
function byNumber(ctx: ToolCtx, number: number): TaskView | null {
  const own = getTaskByNumber(ctx.db, ctx.orgId, number);
  if (own) return own;
  const visible = new Map(visibleProjects(ctx).map((p) => [p.id, p]));
  const orgs = new Set([...visible.values()].map((p) => p.orgId));
  const hits = [...orgs]
    .map((orgId) => getTaskByNumber(ctx.db, orgId, number))
    .filter((t): t is TaskView => t !== null && visible.has(t.projectId));
  if (hits.length > 1) fail(`task #${number} exists in more than one org, use the task id`);
  return hits[0] ?? null;
}

export function task(ctx: ToolCtx, ref: number | string, write: boolean): TaskView {
  const found =
    typeof ref === "number" || /^\d+$/.test(ref)
      ? byNumber(ctx, Number(ref))
      : getTask(ctx.db, ref);
  const ok =
    found &&
    (write
      ? canWrite(ctx, found.projectId)
      : projectAccess(ctx.db, { memberId: ctx.memberId }, found.projectId) !== "none");
  return ok ? found : fail(`task not found: ${ref}`);
}
