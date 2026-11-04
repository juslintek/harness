import type { Database } from "bun:sqlite";
import type { OrgLogHit } from "../../../shared/logs";
import { type EventKind, readBody, snippetFor } from "./api";
import { matchRowids } from "./repo";

export interface OrgSearchQuery {
  text: string;
  kind?: EventKind;
  memberId?: string;
  before?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// FTS ranks across every org, so candidates are over-fetched before the org join trims them.
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

// The org comes from the run's member, never from the event, so a run of another org cannot leak.
export function searchOrgEvents(db: Database, orgId: string, q: OrgSearchQuery): OrgLogHit[] {
  const rowids = matchRowids(db, q.text, CANDIDATES);
  if (rowids.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const where = ["e.rowid IN (SELECT value FROM json_each(?))", "m.org_id = ?"];
  const params: Array<string | number> = [JSON.stringify(rowids), orgId];
  const filters: Array<[string, string | number | undefined]> = [
    ["e.kind = ?", q.kind],
    ["m.id = ?", q.memberId],
    ["e.ts < ?", q.before],
  ];
  for (const [clause, value] of filters) {
    if (value === undefined) continue;
    where.push(clause);
    params.push(value);
  }
  const rows = db
    .query<Raw, Array<string | number>>(
      `SELECT e.rowid, e.id, e.run_id, e.kind, e.ts, e.command, m.handle,
         COALESCE(e.task_id, r.task_id) AS task_id, t.project_id, t.number AS task_number
       FROM events e
       JOIN runs r ON r.id = e.run_id
       JOIN members m ON m.id = r.member_id
       LEFT JOIN tasks t ON t.id = COALESCE(e.task_id, r.task_id)
       WHERE ${where.join(" AND ")}
       ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`,
    )
    .all(...params, limit);
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
