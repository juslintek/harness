import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { countClients, insertClient, pruneClients } from "./repo";

const MAX_REDIRECT_URIS = 5;
// Registration is open to anyone who can reach the origin, so the table must not grow unbounded.
const MAX_CLIENTS = 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

function validRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

// A client name is shown on the consent page: control and bidi characters could disguise it.
const PLAIN_NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const REGISTER_WINDOW_MS = 60_000;
const REGISTER_PER_WINDOW = 30;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

const registerBody = z.object({
  client_name: z.string().trim().min(1).max(100).regex(PLAIN_NAME).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

export function registerRoutes(db: Database, now: () => number): Hono {
  const app = new Hono();
  let windowStart = 0;
  let inWindow = 0;
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    // One shared budget: behind a tunnel every caller arrives from the same address anyway.
    if (now() - windowStart >= REGISTER_WINDOW_MS) [windowStart, inWindow] = [now(), 0];
    if (++inWindow > REGISTER_PER_WINDOW) return c.json({ error: "temporarily_unavailable" }, 429);
    const body = registerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_client_metadata" }, 400);
    if (!body.data.redirect_uris.every(validRedirectUri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    pruneClients(db, now() - PRUNE_AFTER_MS);
    if (countClients(db) >= MAX_CLIENTS) return c.json({ error: "temporarily_unavailable" }, 503);
    const uris = [...new Set(body.data.redirect_uris)];
    const name = body.data.client_name ?? "Unnamed client";
    const issuedAt = now();
    const id = insertClient(db, name, uris, issuedAt);
    return c.json(
      {
        client_id: id,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(issuedAt / 1000),
      },
      201,
    );
  });
  return app;
}
