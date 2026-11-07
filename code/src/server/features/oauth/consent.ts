import type { Database } from "bun:sqlite";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { z } from "zod";
import { assertionBody } from "../../../shared/auth";
import { type ConsentResult, type GrantView, grantViewSchema } from "../../../shared/oauth";
import { forbidden, notFound, parseBody } from "../../route-kit";
import { type AuthEnv, finishStepUp, type Rp, stepUpOptions, stepUpRequired } from "../auth/api";
import { memberForUser } from "../orgs/api";
import { checkAuthRequest, issueCode, matchClient, redirectWith } from "./authorize";
import { SCOPES } from "./metadata";
import { listGrants, revokeGrant } from "./repo";

const consentBody = z.object({
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2000),
  code_challenge: z.string().max(100),
  code_challenge_method: z.string().max(20),
  scope: z.string().max(200).optional(),
  state: z.string().max(500).optional(),
  resource: z.string().max(500),
  org_id: z.string().max(100),
  granted: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
});

const denyBody = z.object({
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2000),
  state: z.string().max(500).optional(),
});

function grantHash(body: z.infer<typeof consentBody>): string {
  const grant = [
    body.client_id,
    body.redirect_uri,
    body.code_challenge,
    body.code_challenge_method,
    body.scope ?? null,
    body.state ?? null,
    body.resource,
    body.org_id,
    body.granted,
  ];
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(grant)).digest("hex");
}

function attachOptions(
  app: Hono<AuthEnv>,
  db: Database,
  origin: string,
  rp: Rp,
  clock: () => number,
): void {
  app.post("/consent/options", async (c) => {
    const body = await parseBody(c, consentBody);
    if (body instanceof Response) return body;
    const check = checkAuthRequest(db, origin, { ...body, response_type: "code" });
    if (!check.ok) return c.json({ error: check.fatal ? check.error : check.description }, 400);
    if (!body.granted.every((s) => check.scopes.includes(s))) {
      return c.json({ error: "granted scopes exceed the request" }, 400);
    }
    const actor = c.get("actor");
    if (!memberForUser(db, body.org_id, actor.userId)) return forbidden(c);
    const options = await stepUpOptions(db, rp, actor.userId);
    db.query("DELETE FROM oauth_consent_challenges WHERE expires_at <= ?").run(clock());
    db.query(`INSERT INTO oauth_consent_challenges
      (challenge_id, session_id, user_id, grant_hash, expires_at) VALUES (?, ?, ?, ?, ?)`).run(
      options.challengeId,
      actor.id,
      actor.userId,
      grantHash(body),
      clock() + 300_000,
    );
    return c.json(options);
  });
}

function attachVerify(app: Hono<AuthEnv>, db: Database, rp: Rp, clock: () => number): void {
  app.post("/consent/verify", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const body = consentBody.safeParse(raw);
    const assertion = assertionBody.safeParse(raw);
    if (!body.success || !assertion.success) return c.json({ error: "invalid body" }, 400);
    const actor = c.get("actor");
    const binding = db
      .query<{ challenge_id: string }, [string, string, string, string, number]>(
        `SELECT challenge_id FROM oauth_consent_challenges
        WHERE challenge_id = ? AND session_id = ? AND user_id = ? AND grant_hash = ?
          AND verified_at IS NULL AND expires_at > ?`,
      )
      .get(assertion.data.challengeId, actor.id, actor.userId, grantHash(body.data), clock());
    if (!binding) return stepUpRequired(c);
    const result = await finishStepUp(
      db,
      rp,
      actor.id,
      actor.userId,
      binding.challenge_id,
      assertion.data.response as AuthenticationResponseJSON,
    );
    if (!result.ok) return c.json({ error: "step-up failed" }, 401);
    const used = db
      .query(
        `UPDATE oauth_consent_challenges SET verified_at = ?
          WHERE challenge_id = ? AND verified_at IS NULL AND expires_at > ?`,
      )
      .run(clock(), binding.challenge_id, clock());
    return used.changes === 1 ? c.json({ ok: true }) : stepUpRequired(c);
  });
}

function attachConsent(
  app: Hono<AuthEnv>,
  db: Database,
  origin: string,
  clock: () => number,
): void {
  app.post("/consent", async (c) => {
    const body = await parseBody(c, consentBody);
    if (body instanceof Response) return body;
    const check = checkAuthRequest(db, origin, { ...body, response_type: "code" });
    if (!check.ok) {
      return c.json({ error: check.fatal ? check.error : check.description }, 400);
    }
    if (!body.granted.every((s) => check.scopes.includes(s))) {
      return c.json({ error: "granted scopes exceed the request" }, 400);
    }
    const actor = c.get("actor");
    const member = memberForUser(db, body.org_id, actor.userId);
    if (!member) return forbidden(c);
    const code = db.transaction(() => {
      const binding = db
        .query(
          `DELETE FROM oauth_consent_challenges
            WHERE session_id = ? AND user_id = ? AND grant_hash = ? AND verified_at IS NOT NULL
              AND expires_at > ? RETURNING challenge_id`,
        )
        .get(actor.id, actor.userId, grantHash(body), clock());
      if (!binding) return null;
      return issueCode(
        db,
        {
          client: check.client,
          redirectUri: check.redirectUri,
          codeChallenge: body.code_challenge,
          scopes: body.granted,
          memberId: member.id,
          orgId: member.orgId,
        },
        clock(),
      );
    })();
    if (!code) return stepUpRequired(c);
    const result: ConsentResult = {
      redirect: redirectWith(check.redirectUri, origin, check.state, { code }),
    };
    return c.json(result);
  });
}

function attachDeny(app: Hono<AuthEnv>, db: Database, origin: string): void {
  app.post("/deny", async (c) => {
    const body = await parseBody(c, denyBody);
    if (body instanceof Response) return body;
    const client = matchClient(db, body);
    if (!client) return c.json({ error: "unknown client or unregistered redirect_uri" }, 400);
    const result: ConsentResult = {
      redirect: redirectWith(body.redirect_uri, origin, body.state, { error: "access_denied" }),
    };
    return c.json(result);
  });
}

export function consentRoutes(
  db: Database,
  origin: string,
  rp: Rp,
  clock: () => number,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  attachOptions(app, db, origin, rp, clock);
  attachVerify(app, db, rp, clock);
  attachConsent(app, db, origin, clock);
  attachDeny(app, db, origin);
  return app;
}

export function grantRoutes(db: Database, clock: () => number): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.get("/grants", (c) => {
    const grants: GrantView[] = listGrants(db, c.get("actor").userId, clock());
    return c.json(z.array(grantViewSchema).parse(grants));
  });
  app.delete("/grants/:id", (c) =>
    revokeGrant(db, c.get("actor").userId, c.req.param("id"), clock())
      ? c.json({ ok: true })
      : notFound(c),
  );
  app.get("/clients/:id", (c) => {
    const client = db
      .query<{ name: string }, [string]>("SELECT name FROM oauth_clients WHERE id = ?")
      .get(c.req.param("id"));
    return client ? c.json({ name: client.name }) : notFound(c);
  });
  return app;
}
