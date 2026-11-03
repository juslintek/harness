import type { Database } from "bun:sqlite";
import type { DashboardTask } from "../../../shared/tracking";
import { runTimes } from "./time";

const TASK_LIMIT = 100;

interface TaskRow {
  id: string;
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  planner: number | null;
  reviewer: number | null;
}

// The newest estimate of each kind is the current one, same rule as the member report.
const latestMinutes = (kind: string): string =>
  `(SELECT e.minutes FROM task_estimates e WHERE e.task_id = t.id AND e.kind = '${kind}'
    ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1)`;

export function dashboardTasks(db: Database, orgId: string, sinceMs: number): DashboardTask[] {
  const rows = db
    .query<TaskRow, [string, number, number]>(
      `SELECT t.id, t.number, t.title, t.status, m.handle AS assignee,
         ${latestMinutes("planner")} AS planner, ${latestMinutes("reviewer")} AS reviewer
       FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id
       WHERE t.org_id = ? AND t.updated_at >= ?
       ORDER BY t.updated_at DESC, t.number DESC LIMIT ?`,
    )
    .all(orgId, sinceMs, TASK_LIMIT);
  const activeMs = new Map<string, number>();
  for (const t of runTimes(db, { orgId, sinceMs })) {
    if (t.taskId) activeMs.set(t.taskId, (activeMs.get(t.taskId) ?? 0) + t.activeMs);
  }
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    plannerMinutes: r.planner,
    reviewerMinutes: r.reviewer,
    agentActiveMinutes: Math.round((activeMs.get(r.id) ?? 0) / 60_000),
  }));
}
