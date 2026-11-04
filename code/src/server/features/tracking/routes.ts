import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { DashboardView } from "../../../shared/tracking";
import { forbidden, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { budgetViews } from "../budgets/api";
import { getOrgBySlug, memberForUser } from "../orgs/api";
import { probeQuota } from "../usage/api";
import { dashboardTasks } from "./dashboard";
import { memberReport } from "./report";

function startOfMonthUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function trackingRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);

  app.get("/orgs/:org/dashboard", async (c) => {
    const org = getOrgBySlug(db, c.req.param("org") ?? "");
    // Unknown slug and foreign org look the same, so the status does not reveal which slugs exist.
    if (!org || !memberForUser(db, org.id, c.get("actor").userId)) return forbidden(c);
    const raw = c.req.query("since");
    const since = raw === undefined ? startOfMonthUtc(Date.now()) : Number(raw);
    if (!Number.isSafeInteger(since) || since < 0) return c.json({ error: "invalid since" }, 400);
    const view: DashboardView = {
      members: memberReport(db, org.id, since),
      budgets: budgetViews(db, org.id),
      quota: await probeQuota(db),
      tasks: dashboardTasks(db, org.id, since),
    };
    return c.json(view);
  });
  return app;
}
