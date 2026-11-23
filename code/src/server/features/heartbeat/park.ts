import type { Database } from "bun:sqlite";
import { appendEvent } from "../logs/api";
import { notifyMembers, orgAdminRecipients } from "../notify/api";
import type { MemberRow } from "../orgs/api";
import { setStatus } from "./repo";

// One pool_exhausted notification per org per exhaustion episode; cleared once a run completes.
const episodes = new WeakMap<Database, Map<string, { active: boolean; seq: number }>>();

function stateFor(db: Database, orgId: string): { active: boolean; seq: number } {
  let map = episodes.get(db);
  if (!map) {
    map = new Map();
    episodes.set(db, map);
  }
  let entry = map.get(orgId);
  if (!entry) {
    entry = { active: false, seq: 0 };
    map.set(orgId, entry);
  }
  return entry;
}

export function clearExhaustedEpisode(db: Database, orgId: string): void {
  stateFor(db, orgId).active = false;
}

export function parkWakes(
  db: Database,
  member: MemberRow,
  ids: string[],
  retryAt: number,
  fromRunId?: string,
): void {
  const detail: Record<string, unknown> = {
    route: "pool_exhausted",
    retryAt,
    ...(fromRunId === undefined ? {} : { parkedFromRunId: fromRunId }),
  };
  setStatus(db, ids, "pending", { notBefore: retryAt, detail });
  const entry = stateFor(db, member.orgId);
  if (entry.active) return;
  const seq = entry.seq + 1;
  const when = new Date(retryAt).toISOString();
  try {
    notifyMembers(db, orgAdminRecipients(db, member.orgId), {
      kind: "pool_exhausted",
      orgId: member.orgId,
      title: "Account pool exhausted",
      body: `All eligible accounts are exhausted; queued work for @${member.handle} is parked until ${when}.`,
      path: "/#/agents",
      tag: `pool_exhausted:${member.orgId}:${seq}`,
    });
    entry.seq = seq;
    entry.active = true;
  } catch (err) {
    appendEvent(db, {
      kind: "error",
      source: "heartbeat",
      body: `pool_exhausted notification failed for org ${member.orgId}: ${String(err)}`,
    });
  }
}
