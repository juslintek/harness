import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import {
  harnessPolicyBody,
  type Layer,
  policyClearQuery,
  policyDecideBody,
  policyExplainQuery,
  policyWriteBody,
  proposalListQuery,
} from "../../../shared/policies";
import { forbidden, notFound, parseBody, parseQuery, routeError } from "../../route-kit";
import { type AuthEnv, hasFreshStepUp, requireStepUp, stepUpRequired } from "../auth/api";
import { getOrgBySlug, type MemberRow, memberForUser, roleAtLeast } from "../orgs/api";
import { decideProposal, getProposal, listProposals } from "./proposals";
import { clearPolicy, contextForMember, contextForTarget, type PolicyContext } from "./repo";
import { explain, setPolicy } from "./resolve";

interface OrgScope {
  orgId: string;
  member: MemberRow;
}

// Strangers get 404 so slugs do not leak; below admin gets 403.
function adminScope(db: Database, c: Context<AuthEnv>): OrgScope | Response {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const member = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
  if (!org || !member) return notFound(c);
  return roleAtLeast(member.role, "admin") ? { orgId: org.id, member } : forbidden(c);
}

// An org-scoped write may only name a target that lives in that org.
function targetInOrg(db: Database, orgId: string, layer: Layer, targetId: string): boolean {
  return contextForTarget(db, layer, targetId)?.orgId === orgId;
}

function explainContext(
  db: Database,
  orgId: string,
  q: { team?: string | undefined; member?: string | undefined; task?: string | undefined },
): PolicyContext | null {
  const ctx = q.member
    ? targetInOrg(db, orgId, "agent", q.member) && contextForMember(db, q.member, q.task)
    : { orgId };
  if (!ctx || ctx.orgId !== orgId) return null;
  if (q.team && !targetInOrg(db, orgId, "team", q.team)) return null;
  if (q.task && !targetInOrg(db, orgId, "task", q.task)) return null;
  return { ...ctx, ...(q.team ? { teamId: q.team } : {}), ...(q.task ? { taskId: q.task } : {}) };
}

export function policiesRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);

  app.get("/orgs/:org/policies", (c) => {
    const scope = adminScope(db, c);
    if (scope instanceof Response) return scope;
    const query = parseQuery(c, policyExplainQuery);
    if (query instanceof Response) return query;
    const ctx = explainContext(db, scope.orgId, query);
    return ctx ? c.json(explain(db, ctx)) : notFound(c);
  });

  app.put("/orgs/:org/policies", async (c) => {
    const scope = adminScope(db, c);
    if (scope instanceof Response) return scope;
    if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
    const body = await parseBody(c, policyWriteBody);
    if (body instanceof Response) return body;
    if (!targetInOrg(db, scope.orgId, body.layer, body.targetId)) return notFound(c);
    const { layer, targetId, key, value } = body;
    const result = setPolicy(db, { layer, targetId, key, value, setBy: scope.member.id });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.reason }, 400);
  });

  app.delete("/orgs/:org/policies", (c) => {
    const scope = adminScope(db, c);
    if (scope instanceof Response) return scope;
    if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
    const query = parseQuery(c, policyClearQuery);
    if (query instanceof Response) return query;
    if (!targetInOrg(db, scope.orgId, query.layer, query.targetId)) return notFound(c);
    clearPolicy(db, query.layer, query.targetId, query.key);
    return c.json({ ok: true });
  });
  proposalRoutes(db, app);
  return app;
}

function proposalRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/orgs/:org/policy-proposals", (c) => {
    const scope = adminScope(db, c);
    if (scope instanceof Response) return scope;
    const query = parseQuery(c, proposalListQuery);
    return query instanceof Response ? query : c.json(listProposals(db, scope.orgId, query.status));
  });

  app.post("/orgs/:org/policy-proposals/:id/decide", async (c) => {
    const scope = adminScope(db, c);
    if (scope instanceof Response) return scope;
    if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
    const proposal = getProposal(db, c.req.param("id"));
    if (proposal?.orgId !== scope.orgId) return notFound(c);
    const body = await parseBody(c, policyDecideBody);
    if (body instanceof Response) return body;
    const result = decideProposal(db, {
      proposalId: proposal.id,
      decidedBy: { kind: "human", userId: c.get("actor").userId },
      decision: body.decision,
      reason: body.reason,
    });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.reason }, 409);
  });
}

// Mounted under the instance-admin routes: the harness layer binds every org.
export function harnessPolicyRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.put("/harness", requireStepUp, async (c) => {
    const body = await parseBody(c, harnessPolicyBody);
    if (body instanceof Response) return body;
    const result = setPolicy(db, {
      layer: "harness",
      targetId: "",
      key: body.key,
      value: body.value,
      setBy: c.get("actor").userId,
    });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.reason }, 400);
  });
  return app;
}
