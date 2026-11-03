import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import { route } from "./api";
import { listRegistry, refreshRegistry } from "./registry";

export function routerRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/registry", (c) => c.json(listRegistry(db, c.req.query("provider"))));
  app.post("/registry/refresh", async (c) => c.json(await refreshRegistry(db)));
  app.get("/route", async (c) => {
    const member = c.req.query("member");
    if (!member) return c.json({ error: "invalid query" }, 400);
    return c.json(await route(db, { memberId: member, taskId: c.req.query("task") }));
  });
  return app;
}
