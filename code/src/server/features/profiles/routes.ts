import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { profileInputSchema } from "../../../shared/profiles";
import { forbidden, notFound, parseBody } from "../../route-kit";
import { getSpec } from "../agents/api";
import type { AuthEnv } from "../auth/api";
import { getMember, getOrgBySlug, memberForUser, roleAtLeast } from "../orgs/api";
import { ensureProfile, profileOfMember, submitCard, updateProfile } from "./api";

// Strangers get 404 so slugs do not leak, like the org routes; the target must belong to that org.
function targetMember(
  db: Database,
  c: Context<AuthEnv>,
  min: "viewer" | "admin",
): string | Response {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  const me = org ? memberForUser(db, org.id, c.get("actor").userId) : null;
  if (!org || !me) return notFound(c);
  if (!roleAtLeast(me.role, min)) return forbidden(c);
  const member = getMember(db, c.req.param("id") ?? "");
  return member?.orgId === org.id ? member.id : notFound(c);
}

export function profilesRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const path = "/orgs/:org/members/:id/profile";

  app.get(path, (c) => {
    const memberId = targetMember(db, c, "viewer");
    if (memberId instanceof Response) return memberId;
    const profile = profileOfMember(db, memberId);
    return profile ? c.json(profile) : notFound(c);
  });

  app.put(path, async (c) => {
    const memberId = targetMember(db, c, "admin");
    if (memberId instanceof Response) return memberId;
    const body = await parseBody(c, profileInputSchema);
    if (body instanceof Response) return body;
    const runtimes = [body.runtime, ...body.fallbacks.map((f) => f.runtime)];
    if (!runtimes.every((id) => getSpec(id))) return c.json({ error: "unknown agent" }, 400);
    return c.json(updateProfile(db, ensureProfile(db, memberId).id, body));
  });

  app.put(`${path}/card`, async (c) => {
    const memberId = targetMember(db, c, "admin");
    if (memberId instanceof Response) return memberId;
    const raw = await c.req.json().catch(() => null);
    const result = submitCard(db, ensureProfile(db, memberId).id, raw);
    return result.ok
      ? c.json(result.card)
      : c.json({ error: "invalid card", issues: result.issues }, 400);
  });

  return app;
}
