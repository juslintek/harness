import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { type Health, healthSchema } from "../shared/health";

export interface AppDeps {
  instanceId: string;
  version: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use(secureHeaders());
  app.get("/api/health", (c) => {
    const body: Health = healthSchema.parse({
      ok: true,
      instanceId: deps.instanceId,
      version: deps.version,
    });
    return c.json(body);
  });
  return app;
}
