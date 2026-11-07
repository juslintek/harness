import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { parseBody } from "../../../route-kit";
import type { AuthEnv } from "../../auth/api";
import { insertTarget } from "../targets-repo";
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
  return app;
}
