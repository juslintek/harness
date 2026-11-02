import type { Database } from "bun:sqlite";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { z } from "zod";
import {
  assertionBody,
  codeBody,
  emailBody,
  enrollOptionsBody,
  enrollVerifyBody,
} from "../../../shared/auth";
import { ensurePersonalOrg } from "../orgs/api";
import {
  completeEnrollment,
  createSession,
  enrollmentUser,
  finishLogin,
  finishRegistration,
  getUser,
  loginOptions,
  newRecoveryCodes,
  type Rp,
  redeemEnrollment,
  registrationOptions,
  requestEmailCode,
  type Session,
  useRecoveryCode,
  verifyEmailCode,
} from "./api";
import { SESSION_COOKIE } from "./middleware";
import { rateLimit } from "./rate-limit";

export interface AuthDeps {
  db: Database;
  rp: Rp;
  deliverEmailCode: (email: string, code: string) => void | Promise<void>;
}

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
const ATTEMPTS_PER_MINUTE = 10;

export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export const invalidBody = (c: Context): Response => c.json({ error: "invalid body" }, 400);

function setSessionCookie(c: Context, rp: Rp, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: rp.origin.startsWith("https:"),
    maxAge: THIRTY_DAYS_S,
  });
}

// Every way in ends here, so the personal org exists whichever method the user used first.
function signIn(
  c: Context,
  deps: AuthDeps,
  userId: string,
  method: Session["method"],
  extra: Record<string, unknown> = {},
): Response {
  const user = getUser(deps.db, userId);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const agent = c.req.header("user-agent")?.slice(0, 200) ?? null;
  const { token } = createSession(deps.db, user.id, method, agent);
  ensurePersonalOrg(deps.db, user);
  setSessionCookie(c, deps.rp, token);
  return c.json({ user, ...extra });
}

const unauthorized = (c: Context): Response => c.json({ error: "unauthorized" }, 401);

function loginRoutes(app: Hono, deps: AuthDeps): void {
  const { db, rp } = deps;
  app.post("/login/options", async (c) => c.json(await loginOptions(db, rp)));
  app.post("/login/verify", async (c) => {
    const body = await parseBody(c, assertionBody);
    if (!body) return invalidBody(c);
    const result = await finishLogin(
      db,
      rp,
      body.challengeId,
      body.response as AuthenticationResponseJSON,
    );
    return result.ok ? signIn(c, deps, result.userId, "passkey") : unauthorized(c);
  });
  app.post("/email/request", async (c) => {
    const body = await parseBody(c, emailBody);
    if (!body) return invalidBody(c);
    // Not awaited: a slow mailer would otherwise show whether the account exists.
    const deliver = (email: string, code: string): void =>
      queueMicrotask(() => {
        Promise.resolve(deps.deliverEmailCode(email, code)).catch((err: unknown) =>
          console.error("email code delivery failed", err),
        );
      });
    const outcome = requestEmailCode(db, body.email, deliver);
    return outcome === "sent" ? c.json({ ok: true }) : c.json({ error: "too many attempts" }, 429);
  });
  app.post("/email/verify", async (c) => {
    const body = await parseBody(c, codeBody);
    if (!body) return invalidBody(c);
    const userId = verifyEmailCode(db, body.email, body.code);
    return userId ? signIn(c, deps, userId, "email") : unauthorized(c);
  });
  app.post("/recovery", async (c) => {
    const body = await parseBody(c, codeBody);
    if (!body) return invalidBody(c);
    const userId = useRecoveryCode(db, body.email, body.code);
    return userId ? signIn(c, deps, userId, "recovery") : unauthorized(c);
  });
}

// The options step fixes the user so the passkey can be bound to a real id and may be repeated
// after a cancelled prompt; only a registered passkey in verify finishes the code.
function enrollRoutes(app: Hono, deps: AuthDeps): void {
  const { db, rp } = deps;
  app.post("/enroll/:code/options", async (c) => {
    const body = await parseBody(c, enrollOptionsBody);
    if (!body) return invalidBody(c);
    const userId = redeemEnrollment(db, c.req.param("code"), body);
    if (!userId) return c.json({ error: "enrollment code is not valid" }, 400);
    return c.json({ ...(await registrationOptions(db, rp, userId)), userId });
  });
  app.post("/enroll/:code/verify", async (c) => {
    const body = await parseBody(c, enrollVerifyBody);
    if (!body) return invalidBody(c);
    // Without this the route would register a passkey for any user id, enrollment or not.
    if (enrollmentUser(db, c.req.param("code")) !== body.userId) {
      return c.json({ error: "enrollment code is not valid" }, 400);
    }
    const result = await finishRegistration(
      db,
      rp,
      body.userId,
      body.challengeId,
      body.response as RegistrationResponseJSON,
      body.name,
    );
    if (!result.ok) return c.json({ error: result.reason }, 400);
    completeEnrollment(db, c.req.param("code"));
    return signIn(c, deps, body.userId, "enroll", {
      recoveryCodes: newRecoveryCodes(db, body.userId),
    });
  });
}

// Everything here works without a session, so it is mounted ahead of the session middleware.
export function publicAuthRoutes(deps: AuthDeps): Hono {
  const app = new Hono();
  const limiter = rateLimit(ATTEMPTS_PER_MINUTE, 60_000);
  for (const path of ["/login/*", "/email/*", "/recovery", "/enroll/*"]) app.use(path, limiter);
  loginRoutes(app, deps);
  enrollRoutes(app, deps);
  return app;
}
