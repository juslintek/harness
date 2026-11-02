import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { wakeupsQuery } from "../../../shared/heartbeat";
import { forbidden, notFound, parseQuery } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { getMember, getOrgBySlug, memberForUser, orgAccess, roleAtLeast } from "../orgs/api";
import { listWakeups, wakeNow } from "./api";
import { WakeCapError } from "./triggers";

export function wakeRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.post("/members/:id/wake", (c) => {
    const target = getMember(db, c.req.param("id"));
    const role = target ? orgAccess(db, c.get("actor").userId, target.orgId) : null;
    if (!target || role === null) return notFound(c);
    if (!roleAtLeast(role, "admin")) return forbidden(c);
    try {
      return c.json({ id: wakeNow(db, target.id, `user:${c.get("actor").userId}`) }, 202);
    } catch (err) {
      if (err instanceof WakeCapError) return c.json({ error: "wake_cap" }, 429);
      return c.json({ error: err instanceof Error ? err.message : "invalid" }, 400);
    }
  });
  app.get("/orgs/:org/wakeups", (c) => {
    const org = getOrgBySlug(db, c.req.param("org"));
    const viewer = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
    if (!org || !viewer) return notFound(c);
    const query = parseQuery(c, wakeupsQuery);
    if (query instanceof Response) return query;
    return c.json(listWakeups(db, org.id, query.limit, viewer.id));
  });
  return app;
}
