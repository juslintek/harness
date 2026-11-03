import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import {
  createOrgBody,
  grantBody,
  memberIdBody,
  nameBody,
  projectBody,
  revokeBody,
} from "../../../shared/orgs";
import { defined, forbidden, notFound, parseBody, routeError } from "../../route-kit";
import { type AuthEnv, getUser } from "../auth/api";
import { ensureProjectChannel, ensureTeamChannel } from "../chat/api";
import {
  addToTeam,
  createOrg,
  createProject,
  createTeam,
  getMember,
  getProject,
  grantProject,
  handleFromEmail,
  listMembers,
  listOrgsForUser,
  listPositions,
  listProjects,
  listTeams,
  type MemberRow,
  type ProjectRow,
  projectMember,
  revokeGrant,
  roleAtLeast,
} from "./api";
import { needStepUp, resolveOrg } from "./routes-kit";
import { memberRoutes } from "./routes-members";
import { positionRoutes } from "./routes-positions";

export interface OrgRouteDeps {
  db: Database;
  origin: string;
}

function orgRoutesBasic(db: Database, app: Hono<AuthEnv>): void {
  app.get("/orgs", (c) => c.json(listOrgsForUser(db, c.get("actor").userId)));
  app.post("/orgs", async (c) => {
    const body = await parseBody(c, createOrgBody);
    if (body instanceof Response) return body;
    const user = getUser(db, c.get("actor").userId);
    if (!user) return notFound(c);
    const org = createOrg(db, {
      name: body.name,
      slug: body.slug,
      ownerUserId: user.id,
      ownerName: user.name,
      ownerHandle: handleFromEmail(user.email),
    });
    return c.json(org, 201);
  });
  app.get("/orgs/:org", (c) => {
    const ctx = resolveOrg(db, c);
    if (ctx instanceof Response) return ctx;
    const { org, member } = ctx;
    return c.json({
      org,
      me: member,
      teams: listTeams(db, org.id),
      members: listMembers(db, org.id),
      positions: listPositions(db, org.id),
      projects: listProjects(db, org.id).map((p) =>
        // The repo path is a host path: only the instance admin sees it, and only for projects this org owns.
        p.orgId === org.id && c.get("actor").instanceAdmin ? p : { ...p, repo: null },
      ),
    });
  });
}

function teamRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/teams", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, nameBody);
    if (body instanceof Response) return body;
    const team = createTeam(db, ctx.org.id, body.name);
    ensureTeamChannel(db, team.id);
    return c.json(team, 201);
  });
  app.post("/orgs/:org/teams/:id/members", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, memberIdBody);
    if (body instanceof Response) return body;
    const team = listTeams(db, ctx.org.id).find((t) => t.id === c.req.param("id"));
    if (!team) return notFound(c);
    if (getMember(db, body.memberId)?.orgId !== ctx.org.id) {
      return c.json({ error: "member not in org" }, 400);
    }
    addToTeam(db, team.id, body.memberId);
    return c.json({ ok: true });
  });
}

function projectRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/projects", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, projectBody);
    if (body instanceof Response) return body;
    // A repo path makes runs cut worktrees from that directory, so only the instance admin may set it, and only with a fresh step-up.
    if (body.repo !== undefined) {
      if (!c.get("actor").instanceAdmin) return forbidden(c);
      const stepUp = needStepUp(c);
      if (stepUp) return stepUp;
    }
    if (body.teamId !== undefined && !listTeams(db, ctx.org.id).some((t) => t.id === body.teamId)) {
      return c.json({ error: "team not in org" }, 400);
    }
    const project = db.transaction(() => {
      const created = createProject(db, { ...defined(body), orgId: ctx.org.id });
      ensureProjectChannel(db, created.id);
      return created;
    })();
    return c.json(project, 201);
  });
}

// Only an admin of the owning org manages grants, and only with a fresh step-up.
function grantTarget(
  db: Database,
  c: Context<AuthEnv>,
): { project: ProjectRow; by: MemberRow } | Response {
  const project = getProject(db, c.req.param("id") ?? "");
  const acting = project ? projectMember(db, c.get("actor").userId, project.id) : null;
  if (!project || !acting) return notFound(c);
  if (acting.member.orgId !== project.orgId || !roleAtLeast(acting.member.role, "admin")) {
    return forbidden(c);
  }
  return needStepUp(c) ?? { project, by: acting.member };
}

function grantRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/projects/:id/grants", async (c) => {
    const target = grantTarget(db, c);
    if (target instanceof Response) return target;
    const body = await parseBody(c, grantBody);
    if (body instanceof Response) return body;
    const exists = db.query("SELECT 1 FROM orgs WHERE id = ?").get(body.orgId);
    if (!exists || body.orgId === target.project.orgId)
      return c.json({ error: "invalid org" }, 400);
    grantProject(db, target.project.id, body.orgId, body.permission, target.by.id);
    return c.json({ ok: true });
  });
  app.delete("/projects/:id/grants", async (c) => {
    const target = grantTarget(db, c);
    if (target instanceof Response) return target;
    const body = await parseBody(c, revokeBody);
    if (body instanceof Response) return body;
    revokeGrant(db, target.project.id, body.orgId);
    return c.json({ ok: true });
  });
}

export function orgRoutes(deps: OrgRouteDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);
  orgRoutesBasic(deps.db, app);
  teamRoutes(deps.db, app);
  projectRoutes(deps.db, app);
  grantRoutes(deps.db, app);
  memberRoutes(deps, app);
  positionRoutes(deps.db, app);
  return app;
}
