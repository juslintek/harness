import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { notFound } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { diffStat } from "./diff";
import { type PipelineDeps, runPipeline } from "./pipeline";
import { decide, getRequest, hasBusyRequest } from "./requests";
import { resolveCommit } from "./steps";

// Mounted behind requireInstanceAdmin; the decisions also need a passkey touch in the last 5 min.
export function approvalRoutes(db: Database, deps: PipelineDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/requests/:id/review", async (c) => {
    const req = getRequest(db, c.req.param("id"));
    if (!req) return notFound(c);
    const stat = deps.runningCommit
      ? await diffStat(req.repo, deps.runningCommit, req.commitSha).catch(() => "")
      : "";
    return c.json({
      id: req.id,
      status: req.status,
      commitSha: req.commitSha,
      flagged: req.flaggedPaths,
      stat,
    });
  });
  app.post("/requests/:id/approve", requireStepUp, async (c) => {
    const req = getRequest(db, c.req.param("id"));
    if (!req) return notFound(c);
    if (req.status !== "awaiting_approval") return c.json({ error: "not_awaiting_approval" }, 409);
    // The approval covers the pinned commit only; a moved branch needs a new request.
    const now = await resolveCommit(req.repo, req.branch).catch(() => null);
    if (now !== req.commitSha) return c.json({ error: "branch_moved" }, 409);
    if (hasBusyRequest(db)) return c.json({ error: "update_in_progress" }, 409);
    if (!decide(db, req.id, "queued", c.get("actor").userId)) {
      return c.json({ error: "not_awaiting_approval" }, 409);
    }
    const queued = getRequest(db, req.id);
    void runPipeline(db, req.id, deps);
    return c.json(queued, 202);
  });
  app.post("/requests/:id/deny", requireStepUp, (c) => {
    const req = getRequest(db, c.req.param("id"));
    if (!req) return notFound(c);
    if (!decide(db, req.id, "denied", c.get("actor").userId)) {
      return c.json({ error: "not_awaiting_approval" }, 409);
    }
    return c.json(getRequest(db, req.id));
  });
  return app;
}
