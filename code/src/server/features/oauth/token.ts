import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { ACCESS_TTL_MS, REFRESH_TTL_MS, resourceUrl } from "./metadata";
import {
  consumeCode,
  findToken,
  insertToken,
  memberLive,
  newSecret,
  revokeFamily,
  revokeToken,
} from "./repo";
import { localClientId } from "./repo-local";

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

type Form = Record<string, string | File | (string | File)[]>;

class TokenError extends Error {
  readonly code: string;
  constructor(code: string, description: string) {
    super(description);
    this.code = code;
  }
}

const invalidGrant = (why: string): TokenError => new TokenError("invalid_grant", why);

const str = (form: Form, key: string): string | undefined =>
  typeof form[key] === "string" ? form[key] : undefined;

function pkceMatches(verifier: string | undefined, challenge: string): boolean {
  if (verifier === undefined || !VERIFIER.test(verifier)) return false;
  const made = Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return made.length === want.length && timingSafeEqual(made, want);
}

interface Pair {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface Subject {
  clientId: string;
  memberId: string;
  orgId: string;
  scopes: string[];
  family: string;
}

function issuePair(db: Database, who: Subject, now: number): Pair {
  if (!memberLive(db, who.memberId, who.orgId)) throw invalidGrant("member left the org");
  const access = newSecret();
  const refresh = newSecret();
  db.transaction(() => {
    insertToken(db, access, { ...who, kind: "access", ttlMs: ACCESS_TTL_MS }, now);
    insertToken(db, refresh, { ...who, kind: "refresh", ttlMs: REFRESH_TTL_MS }, now);
  })();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: who.scopes.join(" "),
  };
}

// The code is spent before anything else is checked, so a guess at the verifier or the redirect
// URI burns it instead of leaving it open for another try.
function exchangeCode(db: Database, origin: string, form: Form, now: number): Pair {
  const code = str(form, "code");
  const used = code === undefined ? null : consumeCode(db, code, now);
  if (used?.kind !== "ok") throw invalidGrant("code is unknown, used or expired");
  const row = used.code;
  if (row.expiresAt <= now) throw invalidGrant("code is unknown, used or expired");
  if (str(form, "client_id") !== row.clientId) throw invalidGrant("client mismatch");
  if (str(form, "redirect_uri") !== row.redirectUri) throw invalidGrant("redirect_uri mismatch");
  if (!pkceMatches(str(form, "code_verifier"), row.codeChallenge)) {
    throw invalidGrant("code_verifier does not match");
  }
  const resource = str(form, "resource");
  if (resource !== undefined && resource !== resourceUrl(origin)) {
    throw new TokenError("invalid_target", "resource must be the MCP resource");
  }
  return issuePair(db, { ...row, family: used.family }, now);
}

// A rotated refresh token is revoked, not deleted: presenting it again is how a stolen copy shows
// up, and then the whole family goes, including the token the thief or the owner holds now.
function rotate(db: Database, form: Form, now: number): Pair {
  const presented = str(form, "refresh_token");
  const row = presented === undefined ? null : findToken(db, presented);
  if (!presented || !row || row.kind !== "refresh") throw invalidGrant("unknown refresh token");
  if (row.clientId !== str(form, "client_id")) throw invalidGrant("client mismatch");
  if (!revokeToken(db, presented, now)) {
    revokeFamily(db, row.family, now);
    throw invalidGrant("refresh token was already used");
  }
  if (row.expiresAt <= now) throw invalidGrant("refresh token expired");
  return issuePair(db, row, now);
}

export function tokenRoutes(db: Database, origin: string, clock: () => number): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const form = (await c.req.parseBody().catch(() => ({}))) as Form;
    const grant = str(form, "grant_type");
    try {
      if (grant === "authorization_code") {
        return c.json(exchangeCode(db, origin, form, clock()));
      }
      if (grant === "refresh_token") return c.json(rotate(db, form, clock()));
      throw new TokenError("unsupported_grant_type", "unsupported grant_type");
    } catch (err) {
      if (!(err instanceof TokenError)) throw err;
      return c.json({ error: err.code, error_description: err.message }, 400);
    }
  });
  return app;
}

const LOCAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// No browser consent happens for the Desktop link, so the caller is trusted to have checked
// the human is signed in and allowed to link.
export function mintLocalToken(db: Database, memberId: string, orgId: string, now: number): string {
  if (!memberLive(db, memberId, orgId)) throw new Error("not a human member of that org");
  const token = newSecret();
  insertToken(
    db,
    token,
    {
      kind: "access",
      clientId: localClientId(db, now),
      memberId,
      orgId,
      scopes: ["board", "chat"],
      family: Bun.randomUUIDv7(),
      ttlMs: LOCAL_TTL_MS,
    },
    now,
  );
  return token;
}
