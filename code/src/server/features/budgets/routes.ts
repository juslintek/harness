import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { budgetBody } from "../../../shared/budgets";
import { forbidden, notFound, parseBody, routeError } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { getOrgBySlug, memberForUser, roleAtLeast } from "../orgs/api";
import { deleteBudget, listBudgets, scopeOrg, upsertBudget } from "./repo";
import { viewOf } from "./spend";

// Strangers get 404 so slugs do not leak; below admin gets 403.
function adminOrg(
  db: Database,
  c: Context<AuthEnv>,
): { orgId: string; memberId: string } | Response {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const member = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
  if (!org || !member) return notFound(c);
  return roleAtLeast(member.role, "admin") ? { orgId: org.id, memberId: member.id } : forbidden(c);
}

export function budgetsRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);

  app.get("/orgs/:org/budgets", (c) => {
    const scope = adminOrg(db, c);
    if (scope instanceof Response) return scope;
    const now = Date.now();
    return c.json(listBudgets(db, scope.orgId).map((b) => viewOf(db, b, now)));
  });

  app.put("/orgs/:org/budgets", requireStepUp, async (c) => {
    const scope = adminOrg(db, c);
    if (scope instanceof Response) return scope;
    const body = await parseBody(c, budgetBody);
    if (body instanceof Response) return body;
    if (scopeOrg(db, { kind: body.scopeKind, id: body.scopeId }) !== scope.orgId) {
      return c.json({ error: "scope not in this org" }, 400);
    }
    const saved = upsertBudget(db, scope.orgId, body, scope.memberId);
    return c.json(viewOf(db, saved, Date.now()));
  });

  app.delete("/orgs/:org/budgets/:id", requireStepUp, (c) => {
    const scope = adminOrg(db, c);
    if (scope instanceof Response) return scope;
    return deleteBudget(db, scope.orgId, c.req.param("id")) ? c.json({ ok: true }) : notFound(c);
  });
  return app;
}
