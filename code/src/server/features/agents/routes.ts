import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { getSpec, LoginError, listAgents, ollayaStatus, setLinked, startLogin } from "./api";
import { keyStatus, type Provider, providers, storeKey } from "./keys";

const linkBody = z.object({ enabled: z.boolean() });
const keyBody = z.object({ key: z.string().regex(/^[\x20-\x7e]{20,400}$/) });

export function agentRoutes(db: Database): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.json(await listAgents(db)));
  app.get("/keys", async (c) => c.json(await keyStatus()));
  app.get("/ollaya", async (c) => c.json(await ollayaStatus()));
  app.post("/keys/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!(providers as readonly string[]).includes(provider))
      return c.json({ error: "unknown provider" }, 404);
    const body = keyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid key" }, 400);
    await storeKey(provider as Provider, body.data.key);
    return c.json({ ok: true });
  });
  app.post("/:id/link", async (c) => {
    const id = c.req.param("id");
    if (!getSpec(id)) return c.json({ error: "unknown agent" }, 404);
    const body = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    setLinked(db, id, body.data.enabled);
    return c.json({ ok: true });
  });
  app.post("/:id/login", (c) => {
    const id = c.req.param("id");
    if (!getSpec(id)?.loginArgs) return c.json({ error: "no login command" }, 404);
    try {
      return c.json(startLogin(id));
    } catch (err) {
      if (err instanceof LoginError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });
  return app;
}
