import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getSecret } from "../agents/api";
import { safeEqual } from "./admin";
import { beginAuthorization, redeemCode, takePending } from "./oidc";
import { getProvider, listProviders } from "./oidc-repo";
import { findUserByEmail } from "./users";

export interface OidcPublicDeps {
  db: Database;
  home: string;
  origin: string;
  login: (c: Context, userId: string) => Response;
}

const STATE_COOKIE = "harness_oidc";
const COOKIE_PATH = "/api/auth/oidc";
const PENDING_COOKIE_S = 10 * 60;

const refused = (c: Context): Response => c.json({ error: "unauthorized" }, 401);

// Lax, unlike the session cookie: it has to come back on the top-level redirect from the provider.
function stateCookie(c: Context, origin: string, state: string): void {
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    path: COOKIE_PATH,
    secure: origin.startsWith("https:"),
    maxAge: PENDING_COOKIE_S,
  });
}

// Existing users only. An address no user has never creates an account; that stays the invite flow.
function userIdFor(db: Database, email: string): string | null {
  return (findUserByEmail(db, email) ?? findUserByEmail(db, email.toLowerCase()))?.id ?? null;
}

async function callback(c: Context, deps: OidcPublicDeps): Promise<Response> {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const bound = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH });
  // Without the browser binding, an attacker could feed a victim a callback for the attacker's own login.
  if (!state || !code || !safeEqual(state, bound)) return refused(c);
  const entry = takePending(state);
  const provider = entry ? getProvider(deps.db, entry.providerId) : null;
  if (!entry || !provider?.enabled) return refused(c);
  const identity = await redeemCode(provider, getSecret(`oidc.${provider.id}`, deps.home), {
    code,
    redirectUri: `${deps.origin}${COOKIE_PATH}/callback`,
    entry,
  });
  const userId = identity ? userIdFor(deps.db, identity.email) : null;
  return userId ? deps.login(c, userId) : refused(c);
}

async function start(c: Context, deps: OidcPublicDeps): Promise<Response> {
  const provider = getProvider(deps.db, c.req.param("id") ?? "");
  if (!provider?.enabled) return c.json({ error: "not found" }, 404);
  const begun = await beginAuthorization(provider, `${deps.origin}${COOKIE_PATH}/callback`);
  if (!begun) return c.json({ error: "provider unavailable" }, 502);
  stateCookie(c, deps.origin, begun.state);
  return c.redirect(begun.location);
}

export function oidcPublicRoutes(app: Hono, deps: OidcPublicDeps): void {
  app.get("/oidc/providers/public", (c) =>
    c.json(
      listProviders(deps.db)
        .filter((p) => p.enabled)
        .map((p) => ({ id: p.id, name: p.name })),
    ),
  );
  app.get("/oidc/callback", (c) => callback(c, deps));
  app.get("/oidc/:id/start", (c) => start(c, deps));
}
