import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { CHANNELS, type Channel, prefSchema } from "../../../shared/notify";
import { notFound, parseBody } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import { getOrgBySlug, listOrgsForUser, memberForUser } from "../orgs/api";
import { effectivePrefs, setPref } from "./prefs";
import { deleteTarget, insertTarget, targetsOf, viewOf } from "./targets-repo";
import { addWebhookTarget, webhookTargetBody } from "./webhook/add";

const REQUIRED: Record<Channel, readonly string[]> = {
  push: ["endpoint", "p256dh", "auth"],
  email: ["address"],
  slack: ["userId"],
  telegram: ["chatId"],
  webhook: ["url", "secretName"],
};

// A webhook is added only through its own body: a client never names the secret it signs with.
const targetBody = z.union([
  webhookTargetBody,
  z.object({
    channel: z.enum(CHANNELS).exclude(["webhook"]),
    value: z.record(z.string(), z.string().max(2000)),
  }),
]);

// Only the keys the channel knows are kept, so a client cannot park extra data in a target.
function cleanValue(
  channel: Channel,
  value: Record<string, string>,
): Record<string, string> | null {
  const kept: Record<string, string> = {};
  for (const key of REQUIRED[channel]) {
    const v = value[key]?.trim();
    if (!v) return null;
    kept[key] = v;
  }
  return kept;
}

// The caller's own member: in the org named by `?org=`, else in the first org they belong to.
function callerMemberId(db: Database, userId: string, slug: string | undefined): string | null {
  const org = slug ? getOrgBySlug(db, slug) : listOrgsForUser(db, userId)[0];
  return org ? (memberForUser(db, org.id, userId)?.id ?? null) : null;
}

type Handler = (memberId: string) => Response | Promise<Response>;

function asCaller(db: Database, c: Context<AuthEnv>, run: Handler): Response | Promise<Response> {
  const memberId = callerMemberId(db, c.get("actor").userId, c.req.query("org"));
  return memberId ? run(memberId) : notFound(c);
}

export function notifyRoutes(db: Database, home?: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/prefs", (c) => asCaller(db, c, (id) => c.json(effectivePrefs(db, id))));
  app.put("/prefs", (c) =>
    asCaller(db, c, async (id) => {
      const body = await parseBody(c, prefSchema);
      if (body instanceof Response) return body;
      setPref(db, id, body.channel, body.kind, body.enabled);
      return c.json(effectivePrefs(db, id));
    }),
  );
  app.get("/targets", (c) => asCaller(db, c, (id) => c.json(targetsOf(db, id).map(viewOf))));
  app.post("/targets", (c) =>
    asCaller(db, c, async (id) => {
      const body = await parseBody(c, targetBody);
      if (body instanceof Response) return body;
      if (body.channel === "webhook") return addWebhookTarget(c, db, home, id, body);
      const value = cleanValue(body.channel, body.value);
      if (!value) return c.json({ error: "invalid body" }, 400);
      return c.json({ id: insertTarget(db, id, body.channel, value) }, 201);
    }),
  );
  app.delete("/targets/:id", (c) =>
    asCaller(db, c, (id) =>
      deleteTarget(db, id, c.req.param("id")) ? c.json({ ok: true }) : notFound(c),
    ),
  );
  return app;
}
