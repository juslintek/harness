import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { hasFreshStepUp, type Session, sessionFromToken } from "./sessions";

export const SESSION_COOKIE = "harness_session";

export interface AuthEnv {
  Variables: { actor: Session };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Agents reach these by the loopback address with a run token, not through the browser origin.
const LOOPBACK_PATHS = new Set(["/mcp", "/api/guard/hook"]);

// Rejects DNS-rebinding: a page on evil.test resolving to 127.0.0.1 still sends its own Host.
export function hostGuard(origin: string, port: number): MiddlewareHandler {
  const browserHost = new URL(origin).host;
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    const loopback = host === `127.0.0.1:${port}` && LOOPBACK_PATHS.has(c.req.path);
    if (host !== browserHost && !loopback) return c.json({ error: "forbidden host" }, 403);
    await next();
  };
}

// Mutations from a browser always carry Origin; anything else is a cross-site or non-browser call.
export function mutationOriginGuard(origin: string): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== origin) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}

// A WebSocket handshake is a GET, so mutationOriginGuard skips it; browsers always send Origin
// on it, and a socket without one has no business here.
export function originGuard(origin: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("origin") !== origin) return c.json({ error: "forbidden origin" }, 403);
    await next();
  };
}

// Only the session cookie opens /api/*; an Authorization header is never looked at here.
export function sessionMiddleware(db: Database): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? sessionFromToken(db, token) : null;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("actor", session);
    await next();
  };
}

export const requireInstanceAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("actor").instanceAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

export function stepUpRequired(c: Context): Response {
  return c.json({ error: "step_up_required" }, 403);
}

export const requireStepUp: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!hasFreshStepUp(c.get("actor"))) return stepUpRequired(c);
  await next();
};
