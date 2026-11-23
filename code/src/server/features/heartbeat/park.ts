import type { Database } from "bun:sqlite";
import { notifyMembers, orgAdminRecipients } from "../notify/api";
import type { MemberRow } from "../orgs/api";
import { setStatus } from "./repo";

// One pool_exhausted notification per org per exhaustion episode; cleared once any run starts.
const notifiedOrgs = new WeakMap<Database, Set<string>>();

function activeSet(db: Database): Set<string> {
  let set = notifiedOrgs.get(db);
  if (!set) {
    set = new Set();
    notifiedOrgs.set(db, set);
  }
  return set;
}

export function clearExhaustedEpisode(db: Database, orgId: string): void {
  activeSet(db).delete(orgId);
}

export function parkWakes(db: Database, member: MemberRow, ids: string[], retryAt: number): void {
  setStatus(db, ids, "pending", {
    notBefore: retryAt,
    detail: { route: "pool_exhausted", retryAt },
  });
  const set = activeSet(db);
  if (set.has(member.orgId)) return;
  set.add(member.orgId);
  const when = new Date(retryAt).toISOString();
  notifyMembers(db, orgAdminRecipients(db, member.orgId), {
    kind: "pool_exhausted",
    orgId: member.orgId,
    title: "Account pool exhausted",
    body: `All eligible accounts are exhausted; queued work for @${member.handle} is parked until ${when}.`,
    path: "/#/agents",
    tag: `pool_exhausted:${member.orgId}`,
  });
}
