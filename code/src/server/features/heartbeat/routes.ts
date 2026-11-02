import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { wakeBody, wakeupsQuery } from "../../../shared/heartbeat";
import { forbidden, notFound, parseQuery } from "../../route-kit";
import { type AuthEnv, hasFreshStepUp, stepUpRequired } from "../auth/api";
import { getTask } from "../board/api";
import {
  getMember,
  getOrgBySlug,
  type MemberRow,
  memberForUser,
  orgAccess,
  projectAccess,
  roleAtLeast,
} from "../orgs/api";
import { listWakeups, wakeNow } from "./api";
import { ViewerError, WakeCapError } from "./triggers";

// A wake starts a host agent run, so an admin on an email-code session is not enough.
function wakeTarget(db: Database, c: Context<AuthEnv>): MemberRow | Response {
  const target = getMember(db, c.req.param("id") ?? "");
  const role = target ? orgAccess(db, c.get("actor").userId, target.orgId) : null;
  if (!target || role === null) return notFound(c);
  if (!roleAtLeast(role, "admin")) return forbidden(c);
  return hasFreshStepUp(c.get("actor")) ? target : stepUpRequired(c);
}

// The wake hands the agent this task's project repo and text, so the agent needs write access there
// and the caller at least read access.
function taskForWake(
  db: Database,
  c: Context<AuthEnv>,
  target: MemberRow,
  taskId: string,
): Response | null {
  const task = getTask(db, taskId);
  if (!task) return c.json({ error: "invalid task" }, 400);
  const mine = projectAccess(db, c.get("actor").userId, task.projectId);
  const theirs = projectAccess(db, { memberId: target.id }, task.projectId);
  if (mine === "none") return c.json({ error: "invalid task" }, 400);
  return theirs === "write" || theirs === "admin" ? null : forbidden(c);
}

async function wakeTask(
  db: Database,
  c: Context<AuthEnv>,
  target: MemberRow,
): Promise<{ taskId: string | undefined } | Response> {
  const body = wakeBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid body" }, 400);
  const { taskId } = body.data;
  return (taskId === undefined ? null : taskForWake(db, c, target, taskId)) ?? { taskId };
}

export function wakeRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.post("/members/:id/wake", async (c) => {
    const target = wakeTarget(db, c);
    if (target instanceof Response) return target;
    const wake = await wakeTask(db, c, target);
    if (wake instanceof Response) return wake;
    try {
      const by = `user:${c.get("actor").userId}`;
      return c.json({ id: wakeNow(db, target.id, by, wake.taskId) }, 202);
    } catch (err) {
      if (err instanceof WakeCapError) return c.json({ error: "wake_cap" }, 429);
      if (err instanceof ViewerError) return c.json({ error: "viewer" }, 409);
      return c.json({ error: err instanceof Error ? err.message : "invalid" }, 400);
    }
  });
  app.get("/orgs/:org/wakeups", (c) => {
    const org = getOrgBySlug(db, c.req.param("org"));
    const viewer = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
    if (!org || !viewer) return notFound(c);
    const query = parseQuery(c, wakeupsQuery);
    if (query instanceof Response) return query;
    return c.json(listWakeups(db, org.id, query.limit, viewer.id));
  });
  return app;
}
