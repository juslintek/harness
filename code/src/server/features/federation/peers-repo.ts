import type { Database } from "bun:sqlite";

export interface PeerRow {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface Raw {
  id: string;
  name: string;
  url: string;
  public_key: string;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const toPeer = (r: Raw): PeerRow => ({
  id: r.id,
  name: r.name,
  url: r.url,
  publicKey: r.public_key,
  pairedAt: r.paired_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
});

export function listPeers(db: Database): PeerRow[] {
  return db.query<Raw, []>("SELECT * FROM peers ORDER BY paired_at, id").all().map(toPeer);
}

// Pairing again with a known instance may refresh its name and url, but never swaps the key and
// never lifts a revocation. False means the id is taken by a different key.
export function insertPeer(db: Database, peer: Omit<PeerRow, "lastSeenAt" | "revokedAt">): boolean {
  return (
    db.run(
      `INSERT INTO peers (id, name, url, public_key, paired_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
         paired_at = excluded.paired_at
       WHERE public_key = excluded.public_key`,
      [peer.id, peer.name, peer.url, peer.publicKey, peer.pairedAt],
    ).changes === 1
  );
}

export function revokePeer(db: Database, id: string, now: number = Date.now()): boolean {
  return (
    db.run("UPDATE peers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id])
      .changes === 1
  );
}

export function getPeer(db: Database, id: string): PeerRow | undefined {
  const row = db.query<Raw, [string]>("SELECT * FROM peers WHERE id = ?").get(id);
  return row ? toPeer(row) : undefined;
}

export function touchPeer(db: Database, id: string, now: number = Date.now()): void {
  db.run("UPDATE peers SET last_seen_at = ? WHERE id = ?", [now, id]);
}
