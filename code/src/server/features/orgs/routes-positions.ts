import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { positionBody, positionPatchBody } from "../../../shared/orgs";
import { defined, notFound, parseBody } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import {
  createPosition,
  getMember,
  listPositions,
  listTeams,
  type PositionRow,
  updatePosition,
} from "./api";
import { needStepUp, type OrgCtx, resolveOrg } from "./routes-kit";

interface Refs {
  teamId?: string | null | undefined;
  memberId?: string | null | undefined;
}

// A position may only point at a team and a member of its own org.
function foreignRef(db: Database, ctx: OrgCtx, refs: Refs): boolean {
  const teamOk = !refs.teamId || listTeams(db, ctx.org.id).some((team) => team.id === refs.teamId);
  const memberOk = !refs.memberId || getMember(db, refs.memberId)?.orgId === ctx.org.id;
  return !(teamOk && memberOk);
}

export function positionRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/positions", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, positionBody);
    if (body instanceof Response) return body;
    if (foreignRef(db, ctx, body)) return c.json({ error: "team or member not in org" }, 400);
    const stepUp = body.isManager ? needStepUp(c) : null;
    return stepUp ?? c.json(createPosition(db, { ...defined(body), orgId: ctx.org.id }), 201);
  });
  app.patch("/orgs/:org/positions/:id", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const current: PositionRow | undefined = listPositions(db, ctx.org.id).find(
      (p) => p.id === c.req.param("id"),
    );
    if (!current) return notFound(c);
    const body = await parseBody(c, positionPatchBody);
    if (body instanceof Response) return body;
    if (foreignRef(db, ctx, body)) return c.json({ error: "team or member not in org" }, 400);
    const manager = body.isManager !== undefined && body.isManager !== current.isManager;
    const stepUp = manager ? needStepUp(c) : null;
    return stepUp ?? c.json(updatePosition(db, current.id, defined(body)));
  });
}
