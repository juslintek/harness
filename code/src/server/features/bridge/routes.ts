import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { notFound, parseBody } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { getChannel } from "../chat/api";
import { getOrgBySlug, listOrgsForUser, memberForUser, orgAccess, roleAtLeast } from "../orgs/api";
import { bridgesOfOrg, getBridge, linkBridge, linkExternalUser, unlinkBridge } from "./repo";

const kind = z.enum(["slack", "telegram"]);
const external = z.string().trim().min(1).max(64);
const linkBody = z.object({ channelId: z.string().min(1).max(64), kind, externalId: external });
const userBody = z.object({ kind, externalUserId: external, org: z.string().max(64).optional() });

function isOrgAdmin(db: Database, c: Context<AuthEnv>, orgId: string): boolean {
  const role = orgAccess(db, c.get("actor").userId, orgId);
  return role !== null && roleAtLeast(role, "admin");
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

export function bridgeRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/links", (c) => {
    const org = getOrgBySlug(db, c.req.query("org") ?? "");
    if (!org || !isOrgAdmin(db, c, org.id)) return notFound(c);
    return c.json(bridgesOfOrg(db, org.id));
  });

  app.post("/links", requireStepUp, async (c) => {
    const body = await parseBody(c, linkBody);
    if (body instanceof Response) return body;
    const channel = getChannel(db, body.channelId);
    if (!channel) return notFound(c);
    // The org comes from the channel itself, never from the request, so an admin of org A cannot
    // attach a channel of org B. Direct and group channels have no org-wide audience.
    if (!isOrgAdmin(db, c, channel.orgId)) return c.json({ error: "forbidden" }, 403);
    if (channel.kind === "dm" || channel.kind === "group") {
      return c.json({ error: "only org, team and project channels can be bridged" }, 400);
    }
    try {
      const id = linkBridge(db, { ...body, orgId: channel.orgId });
      return c.json({ id }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "already linked" }, 409);
      throw err;
    }
  });

  app.delete("/links/:id", (c) => {
    const link = getBridge(db, c.req.param("id"));
    if (!link || !isOrgAdmin(db, c, link.orgId)) return notFound(c);
    unlinkBridge(db, link.id);
    return c.json({ ok: true });
  });

  app.post("/users", async (c) => {
    const body = await parseBody(c, userBody);
    if (body instanceof Response) return body;
    const userId = c.get("actor").userId;
    const org = body.org ? getOrgBySlug(db, body.org) : listOrgsForUser(db, userId)[0];
    const member = org ? memberForUser(db, org.id, userId) : null;
    if (!member) return notFound(c);
    linkExternalUser(db, body.kind, body.externalUserId, member.id);
    return c.json({ ok: true });
  });

  return app;
}
