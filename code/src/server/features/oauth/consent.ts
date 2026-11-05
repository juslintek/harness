import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { type ConsentResult, type GrantView, grantViewSchema } from "../../../shared/oauth";
import { forbidden, notFound, parseBody } from "../../route-kit";
import { type AuthEnv, hasFreshStepUp, stepUpRequired } from "../auth/api";
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

// One passkey tap covers one grant: the tap is remembered per session and refused a second time, so
// a step-up done for something else a minute ago cannot approve a client the person never saw.
const spentStepUps = new Map<string, number>();
const MAX_SPENT = 10_000;

function spendStepUp(sessionId: string, stepUpAt: number | null, fresh: boolean): boolean {
  if (!fresh || stepUpAt === null || spentStepUps.get(sessionId) === stepUpAt) return false;
  if (spentStepUps.size >= MAX_SPENT) spentStepUps.clear();
  spentStepUps.set(sessionId, stepUpAt);
  return true;
}

// Every field comes from the browser, so the request is validated again here exactly as at the
// authorize endpoint; the consent page is not trusted to have done it.
export function consentRoutes(db: Database, origin: string, clock: () => number): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
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
    if (!spendStepUp(actor.id, actor.stepUpAt, hasFreshStepUp(actor, clock()))) {
      return stepUpRequired(c);
    }
    const code = issueCode(
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
    const result: ConsentResult = {
      redirect: redirectWith(check.redirectUri, origin, check.state, { code }),
    };
    return c.json(result);
  });
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
