import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { allowedHosts, COOKIE_NAME, loadOrCreateSecret, safeEqual, sessionValue } from "./admin";
import {
  createEnrollment,
  newRecoveryCodes,
  redeemEnrollment,
  requestEmailCode,
  useRecoveryCode,
  verifyEmailCode,
} from "./codes";
import {
  finishLogin,
  finishRegistration,
  finishStepUp,
  loginOptions,
  registrationOptions,
  stepUpOptions,
} from "./passkeys";
import {
  createSession,
  hasFreshStepUp,
  listSessions,
  revokeSession,
  sessionFromToken,
} from "./sessions";
import { countUsers, findUserByEmail, getUser } from "./users";

export function ensureAdminSecret(home: string): string {
  return loadOrCreateSecret(home);
}

// Rejects DNS-rebinding: a page on evil.test resolving to 127.0.0.1 still sends its own Host.
export function hostGuard(port: number): MiddlewareHandler {
  const hosts = allowedHosts(port);
  return async (c, next) => {
    if (!hosts.includes(c.req.header("host") ?? ""))
      return c.json({ error: "forbidden host" }, 403);
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Only the cookie opens /api/*; an Authorization header is never looked at here.
export function adminMiddleware(secret: string, port: number): MiddlewareHandler {
  const origins = allowedHosts(port).map((host) => `http://${host}`);
  const expected = sessionValue(secret);
  return async (c, next) => {
    if (!safeEqual(getCookie(c, COOKIE_NAME) ?? "", expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!SAFE_METHODS.has(c.req.method) && !origins.includes(c.req.header("origin") ?? "")) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}

// A WebSocket handshake is a GET, so adminMiddleware skips its Origin check; browsers always send
// Origin on it, and a socket without one has no business here.
export function originGuard(port: number): MiddlewareHandler {
  const origins = allowedHosts(port).map((host) => `http://${host}`);
  return async (c, next) => {
    if (!origins.includes(c.req.header("origin") ?? "")) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    await next();
  };
}

export function loginHandler(secret: string): (c: Context) => Response {
  return (c) => {
    const k = c.req.query("k");
    if (!k || !safeEqual(k, secret)) return c.json({ error: "unauthorized" }, 401);
    setCookie(c, COOKIE_NAME, sessionValue(secret), {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect("/");
  };
}

export type { Rp } from "./passkeys";
export type { Session, SessionInfo } from "./sessions";
export type { User } from "./users";
export {
  countUsers,
  createEnrollment,
  createSession,
  findUserByEmail,
  finishLogin,
  finishRegistration,
  finishStepUp,
  getUser,
  hasFreshStepUp,
  listSessions,
  loginOptions,
  newRecoveryCodes,
  redeemEnrollment,
  registrationOptions,
  requestEmailCode,
  revokeSession,
  sessionFromToken,
  stepUpOptions,
  useRecoveryCode,
  verifyEmailCode,
};
