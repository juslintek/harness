import type { Database } from "bun:sqlite";
import type { Channel, DeliverResult, Notification, Target } from "../../../shared/notify";
import { createOrg, memberForUser } from "../orgs/api";
import type { Notifier } from "./port";

export interface FakeNotifier extends Notifier {
  calls: { target: Target; n: Notification; base: string }[];
}

// Answers from `script` in order, then ok.
export function fakeNotifier(channel: Channel, script: DeliverResult[] = []): FakeNotifier {
  const calls: FakeNotifier["calls"] = [];
  return {
    channel,
    calls,
    deliver: async (target, n, base) => {
      calls.push({ target, n, base });
      return script.shift() ?? { ok: true };
    },
  };
}

export function seedMember(
  db: Database,
  handle: string,
): { userId: string; memberId: string; orgId: string; slug: string } {
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
