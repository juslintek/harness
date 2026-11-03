import type { Database } from "bun:sqlite";
import type { TimeRow } from "../../../shared/tracking";

export interface TimeFilter {
  orgId: string;
  sinceMs: number;
  memberId?: string;
  taskId?: string;
}

interface DbTime {
  id: string;
  member_id: string;
  task_id: string | null;
  wall: number;
  waiting: number;
}

// An approval still pending, or expired without a decision, waits until the run ended or now.
export function runTimes(db: Database, filter: TimeFilter, now: number = Date.now()): TimeRow[] {
  const rows = db
    .query<DbTime, (string | number | null)[]>(
      `SELECT r.id, r.member_id, r.task_id,
         COALESCE(r.ended_at, ?1) - r.started_at AS wall,
         (SELECT COALESCE(sum(MAX(0, COALESCE(a.decided_at, MIN(?1, COALESCE(r.ended_at, ?1))) - a.created_at)), 0)
            FROM approvals a WHERE a.run_id = r.id) AS waiting
       FROM runs r JOIN members m ON m.id = r.member_id
       WHERE m.org_id = ?2 AND r.started_at >= ?3
         AND (?4 IS NULL OR r.member_id = ?4) AND (?5 IS NULL OR r.task_id = ?5)
       ORDER BY r.started_at`,
    )
    .all(now, filter.orgId, filter.sinceMs, filter.memberId ?? null, filter.taskId ?? null);
  return rows.map((r) => {
    const waitingMs = Math.min(r.waiting, r.wall);
    return {
      runId: r.id,
      memberId: r.member_id,
      taskId: r.task_id,
      wallMs: r.wall,
      waitingMs,
      activeMs: r.wall - waitingMs,
    };
  });
}
