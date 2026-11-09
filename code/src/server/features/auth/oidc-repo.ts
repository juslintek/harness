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
