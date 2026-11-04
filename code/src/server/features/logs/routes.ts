import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { LOG_KINDS } from "../../../shared/logs";
import { forbidden, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { getOrgBySlug, memberForUser, roleAtLeast } from "../orgs/api";
import type { EventKind } from "./api";
import { type OrgSearchQuery, searchOrgEvents } from "./search-org";

function isKind(v: string): v is EventKind {
  return (LOG_KINDS as readonly string[]).includes(v);
}

function parseQuery(c: Context<AuthEnv>): OrgSearchQuery | string {
  const kind = c.req.query("kind");
  const before = c.req.query("before");
  const memberId = c.req.query("member");
  if (kind && !isKind(kind)) return "invalid kind";
  if (before !== undefined && !Number.isSafeInteger(Number(before))) return "invalid before";
  return {
    text: c.req.query("q") ?? "",
    ...(kind && isKind(kind) && { kind }),
    ...(memberId && { memberId }),
    ...(before !== undefined && { before: Number(before) }),
  };
}

export function logsRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);

  app.get("/orgs/:org/logs/search", (c) => {
    const org = getOrgBySlug(db, c.req.param("org") ?? "");
    const me = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
    // Unknown slug, foreign org and a viewer look the same.
    if (!org || !me || !roleAtLeast(me.role, "member")) return forbidden(c);
    const query = parseQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);
    return c.json(searchOrgEvents(db, org.id, query));
  });
  return app;
}
