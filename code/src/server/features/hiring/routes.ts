import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { createHireBody, decideBody, scoreBody } from "../../../shared/hiring";
import { forbidden, notFound, parseBody, routeError } from "../../route-kit";
import { type AuthEnv, hasFreshStepUp, stepUpRequired } from "../auth/api";
import { getOrgBySlug, type MemberRow, memberForUser, type Role, roleAtLeast } from "../orgs/api";
import { decide, fileRequest, getHire, hiringDeps, listHires, score } from "./api";

// Strangers get 404 so slugs do not leak, like the org routes.
function actor(
  db: Database,
  c: Context<AuthEnv>,
  min: Role,
): { orgId: string; me: MemberRow } | Response {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const me = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
  if (!org || !me) return notFound(c);
  return roleAtLeast(me.role, min) ? { orgId: org.id, me } : forbidden(c);
}

const unavailable = (c: Context): Response => c.json({ error: "hiring_unavailable" }, 503);

function readRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/orgs/:org/hires", (c) => {
    const who = actor(db, c, "viewer");
    return who instanceof Response ? who : c.json(listHires(db, who.orgId));
  });

  app.get("/orgs/:org/hires/:id", (c) => {
    const who = actor(db, c, "viewer");
    if (who instanceof Response) return who;
    const hire = getHire(db, c.req.param("id"));
    return hire?.orgId === who.orgId ? c.json(hire) : notFound(c);
  });
}

function writeRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/hires", async (c) => {
    const who = actor(db, c, "member");
    if (who instanceof Response) return who;
    const body = await parseBody(c, createHireBody);
    if (body instanceof Response) return body;
    const deps = hiringDeps();
    if (!deps) return unavailable(c);
    const { teamId, spec, maxCandidates } = body;
    const hire = await fileRequest(db, deps, {
      orgId: who.orgId,
      teamId,
      requestedBy: who.me.id,
      spec,
      maxCandidates,
    });
    return c.json(hire, 201);
  });

  app.post("/orgs/:org/hires/:id/score/:candidate", async (c) => {
    const who = actor(db, c, "admin");
    if (who instanceof Response) return who;
    const hire = getHire(db, c.req.param("id"));
    const candidateId = c.req.param("candidate");
    if (hire?.orgId !== who.orgId || !hire.candidates.some((k) => k.id === candidateId))
      return notFound(c);
    const body = await parseBody(c, scoreBody);
    if (body instanceof Response) return body;
    const deps = hiringDeps();
    if (!deps) return unavailable(c);
    score(db, deps, { ...body, candidateId, scorerId: who.me.id });
    return c.json(getHire(db, hire.id));
  });

  app.post("/orgs/:org/hires/:id/decide", async (c) => {
    const who = actor(db, c, "admin");
    if (who instanceof Response) return who;
    if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
    const hire = getHire(db, c.req.param("id"));
    if (hire?.orgId !== who.orgId) return notFound(c);
    const body = await parseBody(c, decideBody);
    if (body instanceof Response) return body;
    const deps = hiringDeps();
    if (!deps) return unavailable(c);
    const result = decide(db, deps, { requestId: hire.id, ...body, decidedBy: who.me.id });
    return result.ok ? c.json(result) : c.json({ error: result.reason }, 409);
  });
}

export function hiringRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  readRoutes(db, app);
  writeRoutes(db, app);
  app.onError(routeError);
  return app;
}
