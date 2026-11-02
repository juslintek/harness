import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import {
  type AddHumanBody,
  addAgentBody,
  addHumanBody,
  memberPatchBody,
  type OrgView,
  type Role,
} from "../../../shared/orgs";
import { defined, forbidden, notFound, parseBody } from "../../route-kit";
import { type AuthEnv, createEnrollment, createUser, findUserByEmail } from "../auth/api";
import {
  addAgentMember,
  addHumanMember,
  getMember,
  handleFromEmail,
  listMembers,
  type MemberRow,
  removeMember,
  roleAtLeast,
  updateMember,
} from "./api";
import { needStepUp, type OrgCtx, resolveOrg } from "./routes-kit";

const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;

function lastOwner(db: Database, orgId: string): boolean {
  return listMembers(db, orgId).filter((m) => m.role === "owner").length <= 1;
}

const conflict = (c: Context): Response => c.json({ error: "last_owner" }, 409);

// Owners are the only ones who can hand out or take away ownership; an org never ends up with none.
function ownershipGuard(
  db: Database,
  c: Context<AuthEnv>,
  ctx: OrgCtx,
  target: MemberRow,
  next: Role | null,
): Response | null {
  const touchesOwner = target.role === "owner" || next === "owner";
  if (touchesOwner && ctx.member.role !== "owner") return forbidden(c);
  if (target.role === "owner" && next !== "owner" && lastOwner(db, ctx.org.id)) return conflict(c);
  return null;
}

function roleChangeGuard(
  db: Database,
  c: Context<AuthEnv>,
  ctx: OrgCtx,
  target: MemberRow,
  role: Role,
): Response | null {
  if (role === target.role) return null;
  const owner = ownershipGuard(db, c, ctx, target, role);
  if (owner) return owner;
  const stepUp = needStepUp(c);
  if (stepUp) return stepUp;
  if (target.kind === "agent" && roleAtLeast(role, "admin")) {
    return c.json({ error: "agents cannot be admins" }, 400);
  }
  return null;
}

function orgMember(db: Database, ctx: OrgCtx, id: string | undefined): MemberRow | null {
  const member = id ? getMember(db, id) : null;
  return member?.orgId === ctx.org.id ? member : null;
}

// A new address gets a user row plus an enrollment link to set up a passkey; a known one is just added.
function inviteHuman(
  db: Database,
  origin: string,
  org: OrgView,
  body: AddHumanBody,
): { member: MemberRow; enrollmentLink: string | null } {
  return db.transaction(() => {
    const existing = findUserByEmail(db, body.email);
    const name = existing?.name ?? body.name ?? body.email.split("@")[0] ?? body.email;
    const userId =
      existing?.id ?? createUser(db, { email: body.email, name, instanceAdmin: false });
    const handle = body.handle ?? handleFromEmail(body.email);
    const member = addHumanMember(db, org.id, userId, handle, name, body.role);
    if (existing) return { member, enrollmentLink: null };
    const code = createEnrollment(db, { userId, email: body.email, ttlMs: ENROLLMENT_TTL_MS });
    return { member, enrollmentLink: `${origin}/#/enroll/${code}` };
  })();
}

function memberTarget(
  db: Database,
  c: Context<AuthEnv>,
): { ctx: OrgCtx; target: MemberRow } | Response {
  const ctx = resolveOrg(db, c, "admin");
  if (ctx instanceof Response) return ctx;
  const target = orgMember(db, ctx, c.req.param("id"));
  return target ? { ctx, target } : notFound(c);
}

function addHumanRoutes(db: Database, origin: string, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/members/humans", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, addHumanBody);
    if (body instanceof Response) return body;
    if (body.role === "owner" && ctx.member.role !== "owner") return forbidden(c);
    const stepUp = roleAtLeast(body.role, "admin") ? needStepUp(c) : null;
    return stepUp ?? c.json(inviteHuman(db, origin, ctx.org, body), 201);
  });
}

function addAgentRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.post("/orgs/:org/members/agents", async (c) => {
    const ctx = resolveOrg(db, c, "admin");
    if (ctx instanceof Response) return ctx;
    const body = await parseBody(c, addAgentBody);
    if (body instanceof Response) return body;
    const input = { ...defined(body), specialties: body.specialties ?? [] };
    return c.json(addAgentMember(db, ctx.org.id, input), 201);
  });
}

function changeMemberRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.patch("/orgs/:org/members/:id", async (c) => {
    const found = memberTarget(db, c);
    if (found instanceof Response) return found;
    const { ctx, target } = found;
    const body = await parseBody(c, memberPatchBody);
    if (body instanceof Response) return body;
    const patch = defined(body);
    const denied =
      patch.role === undefined ? null : roleChangeGuard(db, c, ctx, target, patch.role);
    return denied ?? c.json(updateMember(db, target.id, patch));
  });
  app.delete("/orgs/:org/members/:id", (c) => {
    const found = memberTarget(db, c);
    if (found instanceof Response) return found;
    const { ctx, target } = found;
    const denied = target.role === "owner" ? ownershipGuard(db, c, ctx, target, null) : null;
    if (denied) return denied;
    const stepUp = roleAtLeast(target.role, "admin") ? needStepUp(c) : null;
    if (stepUp) return stepUp;
    removeMember(db, target.id);
    return c.json({ ok: true });
  });
}

export function memberRoutes(deps: { db: Database; origin: string }, app: Hono<AuthEnv>): void {
  addHumanRoutes(deps.db, deps.origin, app);
  addAgentRoutes(deps.db, app);
  changeMemberRoutes(deps.db, app);
}
