import type { Database } from "bun:sqlite";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { assertionBody, passkeyBody } from "../../../shared/auth";
import { listOrgsForUser, orgAccess } from "../orgs/api";
import {
  type AuthEnv,
  finishRegistration,
  finishStepUp,
  getUser,
  hasFreshStepUp,
  listSessions,
  newRecoveryCodes,
  type Rp,
  registrationOptions,
  requireStepUp,
  revokeSession,
  stepUpOptions,
} from "./api";
import { deletePasskey, listPasskeys } from "./credentials";
import { SESSION_COOKIE, stepUpRequired } from "./middleware";
import { oidcAdminRoutes } from "./oidc-admin";
import { invalidBody, parseBody } from "./routes";

function passkeyRoutes(app: Hono<AuthEnv>, db: Database, rp: Rp): void {
  app.get("/passkeys", (c) => c.json(listPasskeys(db, c.get("actor").userId)));
  app.post("/passkeys/options", requireStepUp, async (c) =>
    c.json(await registrationOptions(db, rp, c.get("actor").userId)),
  );
  app.post("/passkeys/verify", requireStepUp, async (c) => {
    const body = await parseBody(c, passkeyBody);
    if (!body) return invalidBody(c);
    const result = await finishRegistration(
      db,
      rp,
      c.get("actor").userId,
      body.challengeId,
      body.response as RegistrationResponseJSON,
      body.name,
    );
    return result.ok ? c.json({ id: result.credentialId }) : c.json({ error: result.reason }, 400);
  });
  app.delete("/passkeys/:id", requireStepUp, (c) => {
    const outcome = deletePasskey(db, c.get("actor").userId, c.req.param("id"));
    if (outcome === "missing") return c.json({ error: "unknown passkey" }, 404);
    if (outcome === "last") return c.json({ error: "cannot delete the last passkey" }, 409);
    return c.json({ ok: true });
  });
  app.post("/recovery/regenerate", requireStepUp, (c) =>
    c.json({ recoveryCodes: newRecoveryCodes(db, c.get("actor").userId) }),
  );
}

function stepUpRoutes(app: Hono<AuthEnv>, db: Database, rp: Rp): void {
  app.post("/step-up/options", async (c) =>
    c.json(await stepUpOptions(db, rp, c.get("actor").userId)),
  );
  app.post("/step-up/verify", async (c) => {
    const body = await parseBody(c, assertionBody);
    if (!body) return invalidBody(c);
    const actor = c.get("actor");
    const result = await finishStepUp(
      db,
      rp,
      actor.id,
      actor.userId,
      body.challengeId,
      body.response as AuthenticationResponseJSON,
    );
    return result.ok ? c.json({ ok: true }) : c.json({ error: "step-up failed" }, 401);
  });
}

function sessionRoutes(app: Hono<AuthEnv>, db: Database): void {
  app.get("/sessions", (c) => {
    const actor = c.get("actor");
    return c.json(
      listSessions(db, actor.userId).map((s) => ({ ...s, current: s.id === actor.id })),
    );
  });
  app.delete("/sessions/:id", (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    // Revoking the current session is the same as logout, so it skips step-up on purpose.
    if (id !== actor.id && !hasFreshStepUp(actor)) return stepUpRequired(c);
    return revokeSession(db, actor.userId, id)
      ? c.json({ ok: true })
      : c.json({ error: "unknown session" }, 404);
  });
  app.post("/logout", (c) => {
    const actor = c.get("actor");
    revokeSession(db, actor.userId, actor.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
}

// Mounted behind the session middleware, so every handler here has an actor.
export function accountRoutes(db: Database, rp: Rp, home: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/me", (c) => {
    const actor = c.get("actor");
    return c.json({
      user: getUser(db, actor.userId),
      session: {
        id: actor.id,
        method: actor.method,
        stepUpAt: actor.stepUpAt,
        stepUpFresh: hasFreshStepUp(actor),
      },
      orgs: listOrgsForUser(db, actor.userId).map((org) => ({
        ...org,
        role: orgAccess(db, actor.userId, org.id),
      })),
    });
  });
  passkeyRoutes(app, db, rp);
  stepUpRoutes(app, db, rp);
  sessionRoutes(app, db);
  oidcAdminRoutes(app, db, home);
  return app;
}
