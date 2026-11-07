import type { Database } from "bun:sqlite";
import { consentRoutes, grantRoutes } from "./consent";
import { liveAccessToken } from "./repo";
import { isLocalClient, revokeLocalTokens } from "./repo-local";
import { oauthPublicRoutes } from "./routes";
import { mintLocalToken } from "./token";

export { consentRoutes, grantRoutes, oauthPublicRoutes };

export interface AccessIdentity {
  memberId: string;
  orgId: string;
  scopes: string[];
  clientId: string;
}

// Everything is re-read on each call, never cached: revoking a grant, expiry, narrowing the
// scopes or removing the member from the org takes effect on the very next request.
export function verifyAccessToken(
  db: Database,
  token: string,
  now: number = Date.now(),
): AccessIdentity | null {
  const row = liveAccessToken(db, token, now);
  return row
    ? { memberId: row.memberId, orgId: row.orgId, scopes: row.scopes, clientId: row.clientId }
    : null;
}

export function verifyRemoteAccessToken(
  db: Database,
  token: string,
  now: number = Date.now(),
): AccessIdentity | null {
  const who = verifyAccessToken(db, token, now);
  return who && !isLocalClient(db, who.clientId) ? who : null;
}

export function verifyLocalLinkToken(
  db: Database,
  token: string,
  now: number = Date.now(),
): AccessIdentity | null {
  const who = verifyAccessToken(db, token, now);
  return who && isLocalClient(db, who.clientId) ? who : null;
}

export function mintLocalLinkToken(
  db: Database,
  memberId: string,
  orgId: string,
  now: number = Date.now(),
): string {
  return mintLocalToken(db, memberId, orgId, now);
}

export function revokeLocalLinkTokens(
  db: Database,
  memberId: string,
  now: number = Date.now(),
): number {
  return revokeLocalTokens(db, memberId, now);
}
