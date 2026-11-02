import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { appendEvent } from "../logs/api";
import type { AgentSpec } from "./api";
import {
  getSpec,
  LoginError,
  listAgents,
  type ModelList,
  ModelsError,
  ollayaStatus,
  refreshModels,
  setLinked,
  startLogin,
} from "./api";
import type { Runner } from "./discover";
import { keyStatus, type Provider, providers, storeKey } from "./keys";

const linkBody = z.object({ enabled: z.boolean() });
const keyBody = z.object({ key: z.string().regex(/^[\x20-\x7e]{20,400}$/) });

export interface ModelSources {
  listAcp: (spec: AgentSpec) => Promise<ModelList>;
  run?: Runner;
}

const noAcp: ModelSources = {
  listAcp: () => Promise.reject(new Error("ACP model listing is not wired")),
};

export function agentRoutes(db: Database, models: ModelSources = noAcp): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/", async (c) => c.json(await listAgents(db)));
  app.get("/keys", async (c) =>
    c.json(
      await keyStatus(undefined, undefined, undefined, (provider) =>
        appendEvent(db, {
          kind: "error",
          source: "keys",
          body: `${provider} an old key is still in the login keychain: delete it by hand`,
        }),
      ),
    ),
  );
  app.get("/ollaya", async (c) => c.json(await ollayaStatus()));
  app.post("/keys/:provider", requireStepUp, async (c) => {
    const provider = c.req.param("provider");
    if (!(providers as readonly string[]).includes(provider))
      return c.json({ error: "unknown provider" }, 404);
    const body = keyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid key" }, 400);
    await storeKey(provider as Provider, body.data.key);
    return c.json({ ok: true });
  });
  app.post("/:id/link", requireStepUp, async (c) => {
    const id = c.req.param("id");
    if (!getSpec(id)) return c.json({ error: "unknown agent" }, 404);
    const body = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    setLinked(db, id, body.data.enabled);
    return c.json({ ok: true });
  });
  app.post("/:id/models", async (c) => {
    try {
      return c.json({ models: await refreshModels(db, c.req.param("id"), models) });
    } catch (err) {
      if (err instanceof ModelsError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
  app.post("/:id/login", requireStepUp, (c) => {
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
