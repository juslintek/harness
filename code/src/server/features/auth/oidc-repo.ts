import type { Database } from "bun:sqlite";

export interface OidcProvider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  enabled: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  enabled: number;
  created_at: number;
}

const toProvider = (r: Row): OidcProvider => ({
  id: r.id,
  name: r.name,
  issuer: r.issuer,
  clientId: r.client_id,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

export function listProviders(db: Database): OidcProvider[] {
  return db
    .query<Row, []>("SELECT * FROM oidc_providers ORDER BY created_at, id")
    .all()
    .map(toProvider);
}

export function getProvider(db: Database, id: string): OidcProvider | null {
  const row = db.query<Row, [string]>("SELECT * FROM oidc_providers WHERE id = ?").get(id);
  return row ? toProvider(row) : null;
}

export function insertProvider(
  db: Database,
  input: { name: string; issuer: string; clientId: string; enabled: boolean },
): OidcProvider {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO oidc_providers (id, name, issuer, client_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.name, input.issuer, input.clientId, input.enabled ? 1 : 0, Date.now());
  return getProvider(db, id) as OidcProvider;
}

export function deleteProvider(db: Database, id: string): boolean {
  return db.query("DELETE FROM oidc_providers WHERE id = ?").run(id).changes > 0;
}

export interface OidcPin {
  userId: string;
  issuer: string;
  sub: string;
  createdAt: number;
}

// Trust on first use: the first login pins (issuer, sub) to the user, later logins must match.
// The pin is on the issuer, not the provider row, so deleting and re-adding a provider keeps it.
// The insert is a no-op when the user or the (issuer, sub) is already pinned, so two first logins
// cannot both pin and one identity cannot be pinned to two users.
export function pinIdentity(db: Database, userId: string, issuer: string, sub: string): boolean {
  db.query(
    "INSERT OR IGNORE INTO oidc_identities (user_id, issuer, sub, created_at) VALUES (?, ?, ?, ?)",
  ).run(userId, issuer, sub, Date.now());
  const pinned = db
    .query<{ issuer: string; sub: string }, [string]>(
      "SELECT issuer, sub FROM oidc_identities WHERE user_id = ?",
    )
    .get(userId);
  return pinned?.issuer === issuer && pinned.sub === sub;
}

export function listPins(db: Database, userId: string): OidcPin[] {
  return db
    .query<{ user_id: string; issuer: string; sub: string; created_at: number }, [string]>(
      "SELECT * FROM oidc_identities WHERE user_id = ?",
    )
    .all(userId)
    .map((r) => ({ userId: r.user_id, issuer: r.issuer, sub: r.sub, createdAt: r.created_at }));
}

export function deletePin(db: Database, userId: string): boolean {
  return db.query("DELETE FROM oidc_identities WHERE user_id = ?").run(userId).changes > 0;
}
