import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { sessionFromMobileToken } from "./mobile-devices";
import { hasFreshStepUp, type Session, sessionFromToken } from "./sessions";

export const SESSION_COOKIE = "harness_session";

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

export function setSessionCookie(c: Context, origin: string, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: origin.startsWith("https:"),
    maxAge: THIRTY_DAYS_S,
  });
}

export interface AuthEnv {
  Variables: { actor: Session };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const LOOPBACK_PATHS: ReadonlySet<string> = new Set([
  "/mcp",
  "/mcp/local",
  "/api/guard/hook",
  "/api/health",
]);

export interface PeerServer {
  requestIP(req: Request): { address: string } | null;
}

export function isDirectLoopback(req: Request, server?: PeerServer): boolean {
  const address = server?.requestIP(req)?.address;
  return (
    (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") &&
    !Array.from(req.headers.keys()).some(
      (name) =>
        name === "forwarded" ||
        name === "via" ||
        name === "x-host" ||
        name === "x-real-ip" ||
        name.startsWith("x-forwarded-") ||
        name.startsWith("x-original-") ||
        name.startsWith("x-proxy-") ||
        name.startsWith("proxy-"),
    )
  );
}

// Rejects DNS-rebinding: a page on evil.test resolving to 127.0.0.1 still sends its own Host.
export function hostGuard(origin: string, port: number): MiddlewareHandler {
  const browserHost = new URL(origin).host;
  return async function hostGuard(c, next) {
    const host = c.req.header("host") ?? "";
    const localMcp = c.req.path === "/mcp/local";
    const loopback = host === `127.0.0.1:${port}` && LOOPBACK_PATHS.has(c.req.path);
    if (host !== browserHost && !loopback) return c.json({ error: "forbidden host" }, 403);
    if (localMcp && (!loopback || !isDirectLoopback(c.req.raw, c.env?.server))) {
      return c.json({ error: "forbidden host" }, 403);
    }
    await next();
  };
}

const MOB_BEARER_RE = /^Bearer hmob_[A-Za-z0-9_-]{40,50}$/;
const MOBILE_PUBLIC_PATHS = new Set([
  "/api/auth/mobile/pair/options",
  "/api/auth/mobile/pair/verify",
  "/mobile/pair/options",
  "/mobile/pair/verify",
]);
const MOBILE_ENROLL_RE = /^(?:\/api\/auth)?\/mobile\/enroll\/[^/]+\/(options|verify)$/;

function isAllowedWithoutOrigin(
  path: string,
  authHeader?: string,
  mobHeader?: string,
  cookieHeader?: string,
): boolean {
  if (authHeader && MOB_BEARER_RE.test(authHeader)) return true;
  if (cookieHeader) return false;
  const isPublic = MOBILE_PUBLIC_PATHS.has(path) || MOBILE_ENROLL_RE.test(path);
  return isPublic && mobHeader === "1";
}

function checkOriginAllowed(c: Context, origin: string): boolean {
  const reqOrigin = c.req.header("origin");
  if (reqOrigin !== undefined) return reqOrigin === origin;
  return isAllowedWithoutOrigin(
    c.req.path,
    c.req.header("authorization"),
    c.req.header("x-harness-mobile"),
    c.req.header("cookie"),
  );
}

// Mutations from a browser always carry Origin; anything else is a cross-site or non-browser call.
export function mutationOriginGuard(origin: string): MiddlewareHandler {
  return async function mutationOriginGuard(c, next) {
    if (!SAFE_METHODS.has(c.req.method) && !checkOriginAllowed(c, origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}

// A WebSocket handshake is a GET, so mutationOriginGuard skips it; browsers always send Origin
// on it, and a socket without one has no business here.
export function originGuard(origin: string): MiddlewareHandler {
  return async function originGuard(c, next) {
    if (!checkOriginAllowed(c, origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}

// Only the session cookie or a mobile Bearer token opens /api/*; an Authorization header is evaluated
// on its own and never falls back to the cookie.
export function sessionMiddleware(db: Database, origin?: string): MiddlewareHandler<AuthEnv> {
  return async function sessionMiddleware(c, next) {
    const authHeader = c.req.header("authorization");
    if (authHeader !== undefined) {
      if (!authHeader.startsWith("Bearer hmob_")) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const token = authHeader.slice(7);
      const session = sessionFromMobileToken(db, token);
      if (!session) return c.json({ error: "unauthorized" }, 401);
      c.set("actor", session);
      await next();
      return;
    }
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? sessionFromToken(db, token) : null;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("actor", session);
    if (session.slid && token && origin) setSessionCookie(c, origin, token);
    await next();
  };
}

export const requireInstanceAdmin: MiddlewareHandler<AuthEnv> = async function requireInstanceAdmin(
  c,
  next,
) {
  if (!c.get("actor").instanceAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

export function stepUpRequired(c: Context): Response {
  return c.json({ error: "step_up_required" }, 403);
}

export const requireStepUp: MiddlewareHandler<AuthEnv> = async function requireStepUp(c, next) {
  if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
  await next();
};
