import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { LOG_KINDS } from "../../../shared/logs";
import { forbidden, notFound, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { getOrgBySlug, memberForUser, roleAtLeast } from "../orgs/api";
import type { EventKind } from "./api";
import { type OrgSearchQuery, searchOrgEvents } from "./search-org";

function isKind(v: string): v is EventKind {
  return (LOG_KINDS as readonly string[]).includes(v);
}

// Empty and non-integer values are both invalid; Number("") would silently be 0.
function intParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseQuery(c: Context<AuthEnv>): Omit<OrgSearchQuery, "userId"> | string {
  const kind = c.req.query("kind");
  const memberId = c.req.query("member");
  const before = intParam(c.req.query("before"));
  const beforeRowid = intParam(c.req.query("beforeRowid"));
  if (kind && !isKind(kind)) return "invalid kind";
  if (before === null || beforeRowid === null) return "invalid before";
  return {
    text: c.req.query("q") ?? "",
    ...(kind && isKind(kind) && { kind }),
    ...(memberId && { memberId }),
    ...(before !== undefined && { before }),
    ...(beforeRowid !== undefined && { beforeRowid }),
  };
}

export function logsRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(routeError);

  app.get("/orgs/:org/logs/search", (c) => {
    const org = getOrgBySlug(db, c.req.param("org") ?? "");
    const me = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
    // Strangers get 404 so slugs do not leak; a viewer gets 403.
    if (!org || !me) return notFound(c);
    if (!roleAtLeast(me.role, "member")) return forbidden(c);
    const query = parseQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);
    return c.json(searchOrgEvents(db, org.id, { ...query, userId: c.get("actor").userId }));
  });
  return app;
}
