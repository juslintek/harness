import type { Database } from "bun:sqlite";
import { CODE_TTL_MS, resourceUrl, SCOPES, type Scope } from "./metadata";
import { type ClientRow, getClient, insertCode, newSecret } from "./repo";

export interface AuthRequest {
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  response_type?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  resource?: string | undefined;
}

export type AuthCheck =
  | { ok: true; client: ClientRow; redirectUri: string; scopes: Scope[]; state: string | undefined }
  // Not a registered client or redirect URI: nothing may be redirected there.
  | { ok: false; fatal: true; error: string }
  | {
      ok: false;
      fatal: false;
      redirectUri: string;
      state: string | undefined;
      error: string;
      description: string;
    };

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function parseScopes(raw: string | undefined): Scope[] | null {
  if (raw === undefined || raw.trim() === "") return [...SCOPES];
  const asked = [...new Set(raw.trim().split(/\s+/))];
  return asked.every((s): s is Scope => (SCOPES as readonly string[]).includes(s))
    ? (asked as Scope[])
    : null;
}

function problem(req: AuthRequest, origin: string): { error: string; description: string } | null {
  if (req.response_type !== "code") {
    return { error: "unsupported_response_type", description: "response_type must be code" };
  }
  if (req.code_challenge_method !== "S256") {
    return { error: "invalid_request", description: "code_challenge_method must be S256" };
  }
  if (!req.code_challenge || !CHALLENGE.test(req.code_challenge)) {
    return { error: "invalid_request", description: "code_challenge is missing or malformed" };
  }
  if (req.resource !== resourceUrl(origin)) {
    return { error: "invalid_target", description: "resource must be the MCP resource" };
  }
  if (parseScopes(req.scope) === null) {
    return { error: "invalid_scope", description: "unknown scope" };
  }
  return null;
}

// The client and the redirect URI are checked first and exactly: only after both match is it safe
// to send any later error back to the client's own redirect URI.
export function matchClient(db: Database, req: AuthRequest): ClientRow | null {
  const client = req.client_id ? getClient(db, req.client_id) : null;
  return client && req.redirect_uri !== undefined && client.redirectUris.includes(req.redirect_uri)
    ? client
    : null;
}

export function checkAuthRequest(db: Database, origin: string, req: AuthRequest): AuthCheck {
  const client = matchClient(db, req);
  const uri = req.redirect_uri;
  if (!client || uri === undefined) {
    return { ok: false, fatal: true, error: "unknown client or unregistered redirect_uri" };
  }
  const found = problem(req, origin);
  if (found) return { ok: false, fatal: false, redirectUri: uri, state: req.state, ...found };
  return {
    ok: true,
    client,
    redirectUri: uri,
    scopes: parseScopes(req.scope) ?? [],
    state: req.state,
  };
}

// RFC 9207: the issuer lets a client tell this server's answer from another one's.
export function redirectWith(
  redirectUri: string,
  origin: string,
  state: string | undefined,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", origin);
  return url.toString();
}

export interface Approval {
  client: ClientRow;
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  memberId: string;
  orgId: string;
}

export function issueCode(db: Database, approval: Approval, now: number): string {
  const code = newSecret();
  insertCode(db, code, {
    clientId: approval.client.id,
    memberId: approval.memberId,
    orgId: approval.orgId,
    redirectUri: approval.redirectUri,
    codeChallenge: approval.codeChallenge,
    scopes: approval.scopes,
    expiresAt: now + CODE_TTL_MS,
  });
  return code;
}
