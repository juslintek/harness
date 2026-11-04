import type { Database } from "bun:sqlite";

export type BridgeKind = "slack" | "telegram";

export interface BridgeLink {
  id: string;
  orgId: string;
  channelId: string;
  kind: BridgeKind;
  externalId: string;
  createdAt: number;
}

export interface NewLink {
  orgId: string;
  channelId: string;
  kind: BridgeKind;
  externalId: string;
}

interface Raw {
  id: string;
  org_id: string;
  channel_id: string;
  kind: BridgeKind;
  external_id: string;
  created_at: number;
}

const view = (r: Raw): BridgeLink => ({
  id: r.id,
  orgId: r.org_id,
  channelId: r.channel_id,
  kind: r.kind,
  externalId: r.external_id,
  createdAt: r.created_at,
});

// Throws on a duplicate (kind, externalId): one external chat maps to exactly one channel.
export function linkBridge(db: Database, input: NewLink): string {
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO bridges (id, org_id, channel_id, kind, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.orgId, input.channelId, input.kind, input.externalId, Date.now());
  return id;
}

export function getBridge(db: Database, id: string): BridgeLink | null {
  const r = db.query<Raw, [string]>("SELECT * FROM bridges WHERE id = ?").get(id);
  return r ? view(r) : null;
}

export function unlinkBridge(db: Database, id: string): boolean {
  return db.query("DELETE FROM bridges WHERE id = ?").run(id).changes > 0;
}

export function bridgesOfOrg(db: Database, orgId: string): BridgeLink[] {
  return db
    .query<Raw, [string]>("SELECT * FROM bridges WHERE org_id = ? ORDER BY created_at")
    .all(orgId)
    .map(view);
}

export function bridgesOfChannel(db: Database, channelId: string): BridgeLink[] {
  return db
    .query<Raw, [string]>("SELECT * FROM bridges WHERE channel_id = ?")
    .all(channelId)
    .map(view);
}

export function bridgeByExternal(
  db: Database,
  kind: BridgeKind,
  externalId: string,
): BridgeLink | null {
  const r = db
    .query<Raw, [string, string]>("SELECT * FROM bridges WHERE kind = ? AND external_id = ?")
    .get(kind, externalId);
  return r ? view(r) : null;
}

// Replace, not ignore: the person who really owns the external id can always re-claim it.
export function linkExternalUser(
  db: Database,
  kind: BridgeKind,
  externalUserId: string,
  memberId: string,
): void {
  db.query(
    "INSERT OR REPLACE INTO bridge_users (kind, external_user_id, member_id) VALUES (?, ?, ?)",
  ).run(kind, externalUserId, memberId);
}

export function memberOfExternal(
  db: Database,
  kind: BridgeKind,
  externalUserId: string,
): string | null {
  return (
    db
      .query<{ member_id: string }, [string, string]>(
        "SELECT member_id FROM bridge_users WHERE kind = ? AND external_user_id = ?",
      )
      .get(kind, externalUserId)?.member_id ?? null
  );
}
