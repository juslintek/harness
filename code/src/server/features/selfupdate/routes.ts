import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { notFound, parseBody } from "../../route-kit";
import { type AuthEnv, requireInstanceAdmin } from "../auth/api";
import { approvalRoutes } from "./approval-routes";
import { type PipelineDeps, runPipeline } from "./pipeline";
import { createIfIdle, getRequest } from "./requests";
import { resolveCommit } from "./steps";

const createBody = z.object({ repo: z.string().min(1), branch: z.string().min(1) });

export function pipelineRoutes(db: Database, deps: PipelineDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requireInstanceAdmin);
  app.post("/requests", async (c) => {
    const body = await parseBody(c, createBody);
    if (body instanceof Response) return body;
    const commitSha = await resolveCommit(body.repo, body.branch).catch(() => null);
    if (!commitSha) return c.json({ error: "unknown_branch" }, 400);
    const created = createIfIdle(db, { ...body, commitSha, createdBy: c.get("actor").userId });
    if (!created) return c.json({ error: "update_in_progress" }, 409);
    void runPipeline(db, created.id, deps);
    return c.json(created, 202);
  });
  app.get("/requests/:id", (c) => {
    const found = getRequest(db, c.req.param("id"));
    return found ? c.json(found) : notFound(c);
  });
  app.route("/", approvalRoutes(db, deps));
  return app;
}
