import type { Database } from "bun:sqlite";
import { listChannels } from "../features/chat/api";
import { createOrg, memberForUser } from "../features/orgs/api";

export interface Seed {
  userId: string;
  memberId: string;
  orgId: string;
  slug: string;
}

export function seedMember(db: Database, handle: string): Seed {
  const userId = `u-${handle}`;
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, 0, ?)",
  ).run(userId, `${handle}@example.test`, handle, Date.now());
  const org = createOrg(db, {
    name: handle,
    slug: handle,
    ownerUserId: userId,
    ownerName: handle,
    ownerHandle: handle,
  });
  const member = memberForUser(db, org.id, userId);
  if (!member) throw new Error("owner member missing");
  return { userId, memberId: member.id, orgId: org.id, slug: org.slug };
}

export function orgChannelOf(db: Database, memberId: string): string {
  const found = listChannels(db, memberId).find((c) => c.kind === "org");
  if (!found) throw new Error("no org channel");
  return found.id;
}

export const bodiesOf = (db: Database): string[] =>
  db
    .query<{ body: string }, []>("SELECT body FROM messages ORDER BY created_at, rowid")
    .all()
    .map((r) => r.body);
