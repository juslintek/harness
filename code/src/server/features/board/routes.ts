import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import {
  commentBody,
  createTaskBody,
  depBody,
  moveBody,
  type TaskView,
  taskListQuery,
  taskPatchBody,
} from "../../../shared/board";
import { defined, forbidden, notFound, parseBody, parseQuery, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { type Access, type MemberRow, projectAccess, projectMember } from "../orgs/api";
import {
  addComment,
  addDependency,
  checkout,
  createTask,
  getTask,
  listDeps,
  listTasks,
  moveTask,
  release,
  removeDependency,
  taskDetail,
  updateTask,
} from "./api";

interface Scope {
  member: MemberRow;
  access: Access;
}

// No access at all is a 404 so ids do not leak; read-only callers get 403 on writes.
function scope(
  db: Database,
  c: Context<AuthEnv>,
  projectId: string | undefined,
  need: "read" | "write",
): Scope | Response {
  const acting = projectId ? projectMember(db, c.get("actor").userId, projectId) : null;
  if (!acting) return notFound(c);
  return need === "write" && acting.access === "read" ? forbidden(c) : acting;
}

function taskScope(
  db: Database,
  c: Context<AuthEnv>,
  need: "read" | "write",
): (Scope & { task: TaskView }) | Response {
  const task = getTask(db, c.req.param("id") ?? "");
  if (!task) return notFound(c);
  const found = scope(db, c, task.projectId, need);
  return found instanceof Response ? found : { ...found, task };
}

// An assignee must be someone who can change the project, whichever org they sit in; a reader
// would be woken for work they cannot do.
function assignable(db: Database, projectId: string, memberId: string | null | undefined): boolean {
  if (!memberId) return true;
  const access = projectAccess(db, { memberId }, projectId);
  return access === "write" || access === "admin";
}

function projectTaskRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/projects/:id/tasks", (c) => {
    const found = scope(db, c, c.req.param("id"), "read");
    if (found instanceof Response) return found;
    const query = parseQuery(c, taskListQuery);
    if (query instanceof Response) return query;
    return c.json(listTasks(db, c.req.param("id"), defined(query)));
  });
  app.get("/projects/:id/deps", (c) => {
    const found = scope(db, c, c.req.param("id"), "read");
    return found instanceof Response ? found : c.json(listDeps(db, c.req.param("id")));
  });
  app.post("/projects/:id/tasks", async (c) => {
    const found = scope(db, c, c.req.param("id"), "write");
    if (found instanceof Response) return found;
    const body = await parseBody(c, createTaskBody);
    if (body instanceof Response) return body;
    const projectId = c.req.param("id");
    if (!assignable(db, projectId, body.assigneeId))
      return c.json({ error: "invalid assignee" }, 400);
    return c.json(createTask(db, { ...defined(body), projectId, createdBy: found.member.id }), 201);
  });
}

function taskRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/tasks/:id", (c) => {
    const found = taskScope(db, c, "read");
    return found instanceof Response ? found : c.json(taskDetail(db, found.task.id));
  });
  app.patch("/tasks/:id", async (c) => {
    const found = taskScope(db, c, "write");
    if (found instanceof Response) return found;
    const body = await parseBody(c, taskPatchBody);
    if (body instanceof Response) return body;
    if (!assignable(db, found.task.projectId, body.assigneeId)) {
      return c.json({ error: "invalid assignee" }, 400);
    }
    return c.json(updateTask(db, found.task.id, defined(body), found.member.id));
  });
  app.post("/tasks/:id/comments", async (c) => {
    const found = taskScope(db, c, "write");
    if (found instanceof Response) return found;
    const body = await parseBody(c, commentBody);
    if (body instanceof Response) return body;
    return c.json(addComment(db, found.task.id, found.member.id, body.body), 201);
  });
}

type MoveOutcome = ReturnType<typeof checkout>;

const answer = (c: Context, r: MoveOutcome): Response =>
  r.ok ? c.json(r.task) : c.json(r, r.reason === "not_found" ? 404 : 409);

function moveRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/tasks/:id/move", async (c) => {
    const found = taskScope(db, c, "write");
    if (found instanceof Response) return found;
    const body = await parseBody(c, moveBody);
    if (body instanceof Response) return body;
    return answer(
      c,
      moveTask(db, found.task.id, body.to, found.member.id, defined({ beforeId: body.beforeId })),
    );
  });
  app.post("/tasks/:id/checkout", (c) => {
    const found = taskScope(db, c, "write");
    return found instanceof Response
      ? found
      : answer(c, checkout(db, found.task.id, found.member.id));
  });
  app.post("/tasks/:id/release", (c) => {
    const found = taskScope(db, c, "write");
    return found instanceof Response
      ? found
      : answer(c, release(db, found.task.id, found.member.id));
  });
}

function depRoutes(db: Database, app: Hono<AuthEnv>): void {
  for (const method of ["post", "delete"] as const) {
    app[method]("/tasks/:id/deps", async (c) => {
      const found = taskScope(db, c, "write");
      if (found instanceof Response) return found;
      const body = await parseBody(c, depBody);
      if (body instanceof Response) return body;
      const other = getTask(db, body.dependsOn);
      if (other?.projectId !== found.task.projectId)
        return c.json({ error: "invalid dependency" }, 400);
      if (method === "post") addDependency(db, found.task.id, other.id);
      else removeDependency(db, found.task.id, other.id);
      return c.json({ ok: true });
    });
  }
}

export function boardRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);
  projectTaskRoutes(db, app);
  taskRoutes(db, app);
  moveRoutes(db, app);
  depRoutes(db, app);
  return app;
}
