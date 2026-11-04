import { Hono } from "hono";
import { z } from "zod";
import { parseBody } from "../../route-kit";
import { type AuthEnv, requireStepUp } from "../auth/api";
import { providerSchema, readTunnelConfig, writeTunnelConfig } from "./config";
import { isPublic, type Tunnel } from "./providers";

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const setupBody = z.object({
  provider: providerSchema,
  hostname: z.string().max(253).toLowerCase().regex(HOSTNAME).optional(),
});

// Both flags must be literally true: a missing or stringly "true" never exposes anything.
const startBody = z.object({
  confirm: z.literal(true),
  confirmPublic: z.boolean().optional(),
});

const restartWarning = (origin: string | null): string =>
  `Restart harness for the new origin to apply. Passkeys are bound to the origin hostname, so a passkey enrolled on localhost does not work on ${origin ?? "the tunnel origin"}: enrol a new one there with a recovery code or an email code.`;

export function tunnelRoutes(tunnel: Tunnel, home: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const providers = ["tailscale-serve", "tailscale-funnel", "cloudflare"] as const;
    return c.json({
      detected: await tunnel.detect(),
      config: readTunnelConfig(home),
      running: tunnel.running(),
      commands: Object.fromEntries(providers.map((p) => [p, tunnel.commands(p)])),
    });
  });

  // Writes the file and nothing else: no binary runs, so nothing is exposed by saving a choice.
  app.post("/setup", requireStepUp, async (c) => {
    const body = await parseBody(c, setupBody);
    if (body instanceof Response) return body;
    if (!body.hostname && body.provider !== "cloudflare") {
      return c.json({ error: "hostname required" }, 400);
    }
    const origin = body.hostname ? `https://${body.hostname}` : undefined;
    writeTunnelConfig(home, { provider: body.provider, ...(origin ? { origin } : {}) });
    return c.json({
      provider: body.provider,
      origin: origin ?? null,
      restartRequired: true,
      warning: restartWarning(origin ?? null),
    });
  });

  app.post("/start", requireStepUp, async (c) => {
    const body = await parseBody(c, startBody);
    if (body instanceof Response) return body;
    const config = readTunnelConfig(home);
    if (!config) return c.json({ error: "no tunnel set up" }, 400);
    if (isPublic(config.provider) && body.confirmPublic !== true) {
      return c.json(
        { error: "confirmPublic required: this exposes the instance to the internet" },
        400,
      );
    }
    const result = await tunnel.start(config.provider);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const origin = result.origin ?? config.origin ?? null;
    return c.json({
      running: config.provider,
      origin,
      restartRequired: true,
      warning: restartWarning(origin),
    });
  });

  app.delete("/", requireStepUp, async (c) => {
    const result = await tunnel.stop(readTunnelConfig(home)?.provider);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ running: null });
  });

  return app;
}
