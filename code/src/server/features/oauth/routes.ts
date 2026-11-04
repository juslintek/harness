import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkAuthRequest, redirectWith } from "./authorize";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata";
import { registerRoutes } from "./register";
import { tokenRoutes } from "./token";

export interface OauthDeps {
  db: Database;
  origin: string;
  now?: () => number;
}

const CONSENT_FIELDS = [
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
] as const;

// No session is read here: the cookie is SameSite=Strict, so a navigation that arrives from the
// client's site carries none. The request is validated, then handed to the consent page, which
// runs on this origin with the cookie and asks for step-up before anything is granted.
function authorizeRoute(db: Database, origin: string): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    const query = c.req.query();
    const check = checkAuthRequest(db, origin, query);
    if (!check.ok && check.fatal)
      return c.json({ error: "invalid_request", error_description: check.error }, 400);
    if (!check.ok) {
      const to = redirectWith(check.redirectUri, origin, check.state, {
        error: check.error,
        error_description: check.description,
      });
      return c.redirect(to, 302);
    }
    const forward = new URLSearchParams();
    for (const key of CONSENT_FIELDS) {
      const value = query[key];
      if (value !== undefined) forward.set(key, value);
    }
    return c.redirect(`/#/oauth/consent?${forward}`, 302);
  });
  return app;
}

// Browser-based MCP clients read the metadata and call register and token from their own origin.
// None of these uses a cookie, so a wildcard origin grants nothing a direct caller lacks.
const openCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "authorization", "mcp-protocol-version"],
});

export function oauthPublicRoutes(deps: OauthDeps): Hono {
  const { db, origin } = deps;
  const clock = deps.now ?? Date.now;
  const app = new Hono();
  app.use("/.well-known/*", openCors);
  app.use("/oauth/register", openCors);
  app.use("/oauth/token", openCors);
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(authorizationServerMetadata(origin)),
  );
  app.get("/.well-known/oauth-protected-resource/mcp/remote", (c) =>
    c.json(protectedResourceMetadata(origin)),
  );
  app.route("/oauth/register", registerRoutes(db, clock));
  app.route("/oauth/token", tokenRoutes(db, origin, clock));
  app.route("/oauth/authorize", authorizeRoute(db, origin));
  return app;
}
