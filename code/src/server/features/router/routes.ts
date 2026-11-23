import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import { listRouteDecisions, route } from "./api";
import { listRegistry, refreshRegistry } from "./registry";

export function routerRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/registry", (c) => c.json(listRegistry(db, c.req.query("provider"))));
  app.post("/registry/refresh", async (c) => c.json(await refreshRegistry(db)));
  app.get("/route", async (c) => {
    const member = c.req.query("member");
    if (!member) return c.json({ error: "invalid query" }, 400);
    return c.json(
      await route(db, { memberId: member, taskId: c.req.query("task"), record: false }),
    );
  });
  app.get("/decisions", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "invalid query" }, 400);
    }
    const runId = c.req.query("runId");
    return c.json(
      listRouteDecisions(db, {
        ...(limit === undefined ? {} : { limit }),
        ...(runId === undefined ? {} : { runId }),
      }),
    );
  });
  return app;
}
