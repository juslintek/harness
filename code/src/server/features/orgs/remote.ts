import type { Database } from "bun:sqlite";

// The slug is the lookup key: an org that arrived from the peer (its own home org) shares
// `home_instance` with the stub but never this slug.
const stubSlug = (peerId: string): string => `peer-${peerId.slice(-12).toLowerCase()}`;

export function findRemoteOrg(db: Database, peerId: string): string | null {
  const row = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM orgs WHERE slug = ? AND home_instance = ?",
    )
    .get(stubSlug(peerId), peerId);
  return row?.id ?? null;
}

// The grantee side of a cross-instance share: an org with no members here, standing for the peer.
export function ensureRemoteOrg(db: Database, peerId: string, name: string): string {
  const found = findRemoteOrg(db, peerId);
  if (found) return found;
  const id = Bun.randomUUIDv7();
  db.run("INSERT INTO orgs (id, slug, name, created_at, home_instance) VALUES (?, ?, ?, ?, ?)", [
    id,
    stubSlug(peerId),
    name,
    Date.now(),
    peerId,
  ]);
  return id;
}

// A stub org that arrived with this instance as its home is where the peer's grant lands. Instance
// admins become its admins so the shared project shows up in their project list; grant access is
// still capped by what the peer allowed.
export function adoptRemoteOrgs(db: Database, instanceId: string): void {
  const orgs = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM orgs o WHERE home_instance = ? AND NOT EXISTS (SELECT 1 FROM members WHERE org_id = o.id)",
    )
    .all(instanceId);
  if (orgs.length === 0) return;
  const admins = db
    .query<{ id: string; name: string }, []>("SELECT id, name FROM users WHERE instance_admin = 1")
    .all();
  for (const org of orgs) {
    for (const admin of admins) {
      db.run(
        `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
         VALUES (?, ?, 'human', ?, ?, ?, 'admin', ?)`,
        [
          Bun.randomUUIDv7(),
          org.id,
          admin.id,
          `admin-${admin.id.slice(-6)}`,
          admin.name,
          Date.now(),
        ],
      );
    }
  }
}
