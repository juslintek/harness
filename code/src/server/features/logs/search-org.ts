import type { Database } from "bun:sqlite";
import type { OrgLogHit } from "../../../shared/logs";
import { projectAccess } from "../orgs/api";
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

// A removed member's row is gone (hard delete) but its runs keep member_id, so the org then comes
// from the run's project. A removed member's run with no project cannot be placed in any org.
const IN_ORG = "(m.org_id = ? OR (m.id IS NULL AND p.org_id = ?))";
const RUN_JOINS =
  "LEFT JOIN members m ON m.id = r.member_id LEFT JOIN projects p ON p.id = r.project_id";

// Runs tied to a project are visible only to people who can open that project; the check is done
// per distinct project here so the FTS cap applies after it.
function openableProjects(db: Database, orgId: string, userId: string): string[] {
  return db
    .query<{ project_id: string }, [string, string]>(
      `SELECT DISTINCT r.project_id FROM runs r ${RUN_JOINS}
       WHERE ${IN_ORG} AND r.project_id IS NOT NULL`,
    )
    .all(orgId, orgId)
    .map((r) => r.project_id)
    .filter((id) => projectAccess(db, userId, id) !== "none");
}

function scopeOf(db: Database, orgId: string, q: OrgSearchQuery): RowidScope {
  const where = [
    IN_ORG,
    "(r.project_id IS NULL OR r.project_id IN (SELECT value FROM json_each(?)))",
  ];
  const params: Array<string | number> = [
    orgId,
    orgId,
    JSON.stringify(openableProjects(db, orgId, q.userId)),
  ];
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
      ${RUN_JOINS} WHERE ${where.join(" AND ")}`,
    params,
  };
}

// The org comes from the run's member (or its project once the member is removed), never from the event, so a run of another org cannot leak.
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
