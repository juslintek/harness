import type { Database } from "bun:sqlite";
export interface ClientRow {
  id: string;
  name: string;
  redirectUris: string[];
}

export interface TokenRow {
  kind: "access" | "refresh";
  clientId: string;
  memberId: string;
  orgId: string;
  scopes: string[];
  expiresAt: number;
  revokedAt: number | null;
  family: string;
}

export interface CodeRow {
  clientId: string;
  memberId: string;
  orgId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}

export interface GrantRow {
  id: string;
  clientName: string;
  orgId: string;
  orgName: string;
  scopes: string[];
  createdAt: number;
}

// Only the hash is stored, so a copy of the database cannot be replayed as a credential.
const hashSecret = (secret: string): string =>
  new Bun.CryptoHasher("sha256").update(secret).digest("hex");

export const newSecret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export function insertClient(
  db: Database,
  name: string,
  redirectUris: string[],
  now: number,
): string {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, name, JSON.stringify(redirectUris), now);
  return id;
}

// Only clients that never got a code or a token: deleting a used client would cascade to its grants.
export function pruneClients(db: Database, olderThan: number): void {
  db.query(
    `DELETE FROM oauth_clients WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = oauth_clients.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = oauth_clients.id)`,
  ).run(olderThan);
}

export const countClients = (db: Database): number =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_clients").get()?.n ?? 0;

export function getClient(db: Database, id: string): ClientRow | null {
  const row = db
    .query<{ id: string; name: string; redirect_uris: string }, [string]>(
      "SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?",
    )
    .get(id);
  return row
    ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] }
    : null;
}

export function insertCode(db: Database, code: string, row: CodeRow): void {
  db.query(
    `INSERT INTO oauth_codes
       (hash, client_id, member_id, org_id, redirect_uri, code_challenge, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashSecret(code),
    row.clientId,
    row.memberId,
    row.orgId,
    row.redirectUri,
    row.codeChallenge,
    row.scopes.join(" "),
    row.expiresAt,
  );
}

interface RawCode {
  client_id: string;
  member_id: string;
  org_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: number;
}

export type CodeUse =
  | { kind: "ok"; code: CodeRow; family: string }
  | { kind: "unknown" | "reused" };

// The UPDATE is the single-use gate: of two concurrent exchanges only one changes a row.
export function consumeCode(db: Database, code: string, now: number): CodeUse {
  const hash = hashSecret(code);
  const raw = db.query<RawCode, [string]>("SELECT * FROM oauth_codes WHERE hash = ?").get(hash);
  if (!raw) return { kind: "unknown" };
  const claimed = db
    .query("UPDATE oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL")
    .run(now, hash);
  if (claimed.changes === 0) {
    revokeFamily(db, hash, now);
    return { kind: "reused" };
  }
  return {
    kind: "ok",
    family: hash,
    code: {
      clientId: raw.client_id,
      memberId: raw.member_id,
      orgId: raw.org_id,
      redirectUri: raw.redirect_uri,
      codeChallenge: raw.code_challenge,
      scopes: raw.scopes.split(" "),
      expiresAt: raw.expires_at,
    },
  };
}

export interface NewToken {
  kind: "access" | "refresh";
  clientId: string;
  memberId: string;
  orgId: string;
  scopes: string[];
  family: string;
  ttlMs: number;
}

export function insertToken(db: Database, token: string, row: NewToken, now: number): void {
  db.query(
    `INSERT INTO oauth_tokens
       (hash, kind, client_id, member_id, org_id, scopes, expires_at, created_at, family)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashSecret(token),
    row.kind,
    row.clientId,
    row.memberId,
    row.orgId,
    row.scopes.join(" "),
    now + row.ttlMs,
    now,
    row.family,
  );
}

interface RawToken {
  kind: "access" | "refresh";
  client_id: string;
  member_id: string;
  org_id: string;
  scopes: string;
  expires_at: number;
  revoked_at: number | null;
  family: string;
}

export function findToken(db: Database, token: string): TokenRow | null {
  const raw = db
    .query<RawToken, [string]>("SELECT * FROM oauth_tokens WHERE hash = ?")
    .get(hashSecret(token));
  return raw
    ? {
        kind: raw.kind,
        clientId: raw.client_id,
        memberId: raw.member_id,
        orgId: raw.org_id,
        scopes: raw.scopes.split(" "),
        expiresAt: raw.expires_at,
        revokedAt: raw.revoked_at,
        family: raw.family,
      }
    : null;
}

// True only for the caller that flipped the row, so a refresh token rotates at most once.
export function revokeToken(db: Database, token: string, now: number): boolean {
  return (
    db
      .query("UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL")
      .run(now, hashSecret(token)).changes === 1
  );
}

export function revokeFamily(db: Database, family: string, now: number): number {
  return db
    .query("UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL")
    .run(now, family).changes;
}

// A grant belongs to the person: their member rows in every org, matched by user id.
const OWN_MEMBERS = "SELECT id FROM members WHERE user_id = ?";

export function listGrants(db: Database, userId: string, now: number): GrantRow[] {
  return db
    .query<
      {
        family: string;
        name: string;
        org_id: string;
        org_name: string;
        scopes: string;
        created_at: number;
      },
      [string, number]
    >(
      `SELECT t.family, c.name, t.org_id, o.name AS org_name, t.scopes, MIN(t.created_at) AS created_at
         FROM oauth_tokens t
         JOIN oauth_clients c ON c.id = t.client_id
         JOIN orgs o ON o.id = t.org_id
        WHERE t.member_id IN (${OWN_MEMBERS})
        GROUP BY t.family
       HAVING SUM(t.revoked_at IS NULL AND t.expires_at > ?) > 0
        ORDER BY created_at DESC`,
    )
    .all(userId, now)
    .map((r) => ({
      id: r.family,
      clientName: r.name,
      orgId: r.org_id,
      orgName: r.org_name,
      scopes: r.scopes.split(" "),
      createdAt: r.created_at,
    }));
}

export function revokeGrant(db: Database, userId: string, family: string, now: number): boolean {
  return (
    db
      .query(
        `UPDATE oauth_tokens SET revoked_at = ?
          WHERE family = ? AND revoked_at IS NULL AND member_id IN (${OWN_MEMBERS})`,
      )
      .run(now, family, userId).changes > 0
  );
}

// A removed member, a removed org or a deleted user leaves no row to match.
export function memberLive(db: Database, memberId: string, orgId: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        `SELECT 1 AS one FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.id = ? AND m.org_id = ? AND m.kind = 'human'`,
      )
      .get(memberId, orgId) !== null
  );
}

export function liveAccessToken(db: Database, token: string, now: number): TokenRow | null {
  const row = findToken(db, token);
  if (row?.kind !== "access" || row.revokedAt !== null || row.expiresAt <= now) return null;
  return memberLive(db, row.memberId, row.orgId) ? row : null;
}

const LOCAL_CLIENT_NAME = "Claude Desktop (local)";

export function localClientId(db: Database, now: number): string {
  const found = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM oauth_clients WHERE name = ? AND redirect_uris = '[]'",
    )
    .get(LOCAL_CLIENT_NAME);
  return found?.id ?? insertClient(db, LOCAL_CLIENT_NAME, [], now);
}
