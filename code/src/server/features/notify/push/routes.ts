import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { MobilePushSubscribeBody } from "../../../../shared/notify";
import { parseBody } from "../../../route-kit";
import { setSecret } from "../../agents/api";
import type { AuthEnv } from "../../auth/api";
import { safeEndpoint } from "../endpoint/api";
import { insertTarget, targetsOf, upsertMobileTarget } from "../targets-repo";
import { allowedEndpoint, decodeKeys } from "./adapter";
import { vapidPublicKey } from "./vapid";

export type AsCaller = (
  c: Context<AuthEnv>,
  run: (memberId: string) => Response | Promise<Response>,
) => Response | Promise<Response>;

const subscribeBody = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

function registerMobile(
  db: Database,
  home: string,
  memberId: string,
  body: MobilePushSubscribeBody,
): string {
  const existing = targetsOf(db, memberId, "push").find(
    (t) => t.value.kind === "mobile_relay" && t.value.pushToken === body.pushToken,
  );
  const id = existing?.id ?? Bun.randomUUIDv7();
  let secretName = existing?.value.secretName;
  if (body.relaySecret) {
    secretName = secretName ?? `push.${id}`;
    setSecret(secretName, body.relaySecret, home);
  }
  const value: Record<string, string> = {
    kind: "mobile_relay",
    relayUrl: body.relayUrl,
    platform: body.platform,
    appId: body.appId,
    pushToken: body.pushToken,
    ...(secretName ? { secretName } : {}),
  };
  return upsertMobileTarget(db, memberId, value, id);
}

export function pushRoutes(db: Database, home: string, asCaller: AsCaller): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/key", (c) => c.json({ key: vapidPublicKey(home) }));
  app.post("/subscribe", (c) =>
    asCaller(c, async (memberId) => {
      const body = await parseBody(c, subscribeBody);
      if (body instanceof Response) return body;
      const { endpoint, keys } = body;
      if (!(await allowedEndpoint(endpoint)) || !decodeKeys(keys.p256dh, keys.auth)) {
        return c.json({ error: "invalid subscription" }, 400);
      }
      const value = { endpoint, p256dh: keys.p256dh, auth: keys.auth };
      return c.json({ id: insertTarget(db, memberId, "push", value) }, 201);
    }),
  );
  app.post("/mobile", (c) =>
    asCaller(c, async (memberId) => {
      const body = await parseBody(c, MobilePushSubscribeBody);
      if (body instanceof Response) return body;
      const check = await safeEndpoint(body.relayUrl);
      if (!check.ok) return c.json({ error: "invalid relay url" }, 400);
      return c.json({ id: registerMobile(db, home, memberId, body) }, 201);
    }),
  );
  return app;
}
