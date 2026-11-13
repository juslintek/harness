import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError, forbidden, notFound, parseBody } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { getProject, projectMember, roleAtLeast } from "../orgs/api";
import { listShares, shareProject, unshareProject } from "./share";

const shareBody = z.object({
  projectId: z.string().min(1).max(100),
  peerId: z.string().min(1).max(100),
  permission: z.enum(["read", "write"]),
});

// The same rule as a local grant: an admin of the org that owns the project.
function canAdminister(db: Database, userId: string, projectId: string): boolean {
  const project = getProject(db, projectId);
  const acting = project ? projectMember(db, userId, projectId) : null;
  return (
    project !== null &&
    acting !== null &&
    acting.member.orgId === project.orgId &&
    roleAtLeast(acting.member.role, "admin")
  );
}

export function shareRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/", (c) => c.json(listShares(db, (id) => canAdminister(db, c.get("actor").userId, id))));
  app.post("/", requireStepUp, async (c) => {
    const body = await parseBody(c, shareBody);
    if (body instanceof Response) return body;
    const userId = c.get("actor").userId;
    const acting = projectMember(db, userId, body.projectId);
    if (!acting) return notFound(c);
    if (!canAdminister(db, userId, body.projectId)) return forbidden(c);
    try {
      shareProject(db, body.projectId, body.peerId, body.permission, acting.member.id);
    } catch (err) {
      if (err instanceof DomainError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json({ ok: true }, 201);
  });
  app.delete("/:projectId/:peerId", requireStepUp, (c) => {
    const projectId = c.req.param("projectId");
    const userId = c.get("actor").userId;
    if (!projectMember(db, userId, projectId)) return notFound(c);
    if (!canAdminister(db, userId, projectId)) return forbidden(c);
    return unshareProject(db, projectId, c.req.param("peerId"))
      ? c.json({ ok: true })
      : notFound(c);
  });
  return app;
}
