import type { Database } from "bun:sqlite";
import type { OrgLogHit } from "../../../shared/logs";
import { orgAccess, projectAccess, roleAtLeast } from "../orgs/api";
import { type EventKind, readBody, snippetFor } from "./api";
import { matchRowids, type RowidScope } from "./repo";

export interface OrgSearchQuery {
  userId: string;
  text: string;
  kind?: EventKind;
  memberId?: string;
  before?: number;
  beforeRowid?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CANDIDATES = 5000;

interface Raw {
  rowid: number;
  id: string;
  run_id: string;
  kind: string;
  ts: number;
  command: string | null;
  handle: string;
  task_id: string | null;
  project_id: string | null;
  task_number: number | null;
}

// Runs tied to a project are visible only to people who can open that project; the check is done
// per distinct project here so the FTS cap applies after it.
function openableProjects(db: Database, orgId: string, userId: string): string[] {
  return db
    .query<{ project_id: string }, [string]>(
      "SELECT DISTINCT project_id FROM runs WHERE org_id = ? AND project_id IS NOT NULL",
    )
    .all(orgId)
    .map((r) => r.project_id)
    .filter((id) => projectAccess(db, userId, id) !== "none");
}

// Event kinds that carry conversation text (agent messages and thoughts); only org admins search them.
const TRANSCRIPT_KINDS = ["message"];

// A run with no project can come from a private channel or a DM wake, so only org admins see it.
function isOrgAdmin(db: Database, orgId: string, userId: string): boolean {
  const role = orgAccess(db, userId, orgId);
  return role !== null && roleAtLeast(role, "admin");
}

function scopeOf(db: Database, orgId: string, q: OrgSearchQuery): RowidScope {
  const admin = isOrgAdmin(db, orgId, q.userId);
  const where = [
    "r.org_id = ?",
    "((r.project_id IS NULL AND ?) OR r.project_id IN (SELECT value FROM json_each(?)))",
  ];
  const params: Array<string | number> = [
    orgId,
    admin ? 1 : 0,
    JSON.stringify(openableProjects(db, orgId, q.userId)),
  ];
  if (!admin) {
    where.push(`e.kind NOT IN (${TRANSCRIPT_KINDS.map(() => "?").join(", ")})`);
    params.push(...TRANSCRIPT_KINDS);
  }
  if (q.kind !== undefined) {
    where.push("e.kind = ?");
    params.push(q.kind);
  }
  if (q.memberId !== undefined) {
    where.push("r.member_id = ?");
    params.push(q.memberId);
  }
  if (q.before !== undefined && q.beforeRowid !== undefined) {
    where.push("(e.ts < ? OR (e.ts = ? AND e.rowid < ?))");
    params.push(q.before, q.before, q.beforeRowid);
  } else if (q.before !== undefined) {
    where.push("e.ts < ?");
    params.push(q.before);
  }
  return {
    sql: `SELECT e.rowid FROM events e JOIN runs r ON r.id = e.run_id
      WHERE ${where.join(" AND ")}`,
    params,
    newestFirst: true,
  };
}

// The org is the one stored on the run at start, never read from the event or a later member row, so a run of another org cannot leak.
// The scope is applied inside the FTS match so other orgs' hits cannot crowd out this org's.
export function searchOrgEvents(
  db: Database,
  orgId: string,
  q: OrgSearchQuery,
  cap: number = CANDIDATES,
): OrgLogHit[] {
  const scope = scopeOf(db, orgId, q);
  const rowids = matchRowids(db, q.text, cap, scope);
  if (rowids.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rows = db
    .query<Raw, [string, number]>(
      `SELECT e.rowid, e.id, e.run_id, e.kind, e.ts, e.command, COALESCE(m.handle, '(removed)') AS handle,
         COALESCE(e.task_id, r.task_id) AS task_id, t.project_id, t.number AS task_number
       FROM events e
       JOIN runs r ON r.id = e.run_id
       LEFT JOIN members m ON m.id = r.member_id
       LEFT JOIN tasks t ON t.id = COALESCE(e.task_id, r.task_id)
       WHERE e.rowid IN (SELECT value FROM json_each(?))
       ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`,
    )
    .all(JSON.stringify(rowids), limit);
  return rows.map((r) => ({
    rowid: r.rowid,
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    ts: r.ts,
    snippet: snippetFor(readBody(db, r.rowid), r.command, q.text),
    memberHandle: r.handle,
    taskId: r.task_id,
    projectId: r.project_id,
    taskNumber: r.task_number,
  }));
}
