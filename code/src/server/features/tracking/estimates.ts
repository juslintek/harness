import type { Database } from "bun:sqlite";
import { SIZE_PRIOR_MINUTES } from "../../../shared/router";
import type { EstimateKind, EstimateSource, EstimateView } from "../../../shared/tracking";
import { triageOf } from "../router/api";

export interface NewEstimate {
  taskId: string;
  kind: EstimateKind;
  minutes: number;
  source: EstimateSource;
  byMember?: string;
  rationale?: string;
}

export function addEstimate(db: Database, e: NewEstimate): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO task_estimates (id, task_id, kind, minutes, source, by_member, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Bun.randomUUIDv7(),
      e.taskId,
      e.kind,
      e.minutes,
      e.source,
      e.byMember ?? null,
      e.rationale ?? null,
      Date.now(),
    );
    if (e.kind === "planner") {
      db.query("UPDATE tasks SET estimate_minutes = ? WHERE id = ?").run(e.minutes, e.taskId);
    }
  })();
}

export function priorFor(db: Database, taskId: string): number | null {
  const triage = triageOf(db, taskId);
  return triage ? SIZE_PRIOR_MINUTES[triage.size] : null;
}

export function estimatesOf(db: Database, taskId: string): EstimateView[] {
  const rows = db
    .query<Record<string, string | number | null>, [string]>(
      "SELECT * FROM task_estimates WHERE task_id = ? ORDER BY created_at, rowid",
    )
    .all(taskId);
  return rows.map((r) => ({
    id: r.id as string,
    taskId: r.task_id as string,
    kind: r.kind as EstimateKind,
    minutes: r.minutes as number,
    source: r.source as EstimateSource,
    byMember: r.by_member as string | null,
    rationale: r.rationale as string | null,
    createdAt: r.created_at as number,
  }));
}

// A planner's own number always wins over the size prior, so the prior only fills a gap.
export function seedPrior(db: Database, taskId: string): void {
  const minutes = priorFor(db, taskId);
  if (minutes === null) return;
  const taken = db
    .query<{ n: number }, [string]>(
      `SELECT (SELECT count(*) FROM task_estimates WHERE task_id = ?1 AND kind = 'planner')
            + (SELECT count(*) FROM tasks WHERE id = ?1 AND estimate_minutes IS NOT NULL) AS n`,
    )
    .get(taskId);
  if (taken && taken.n > 0) return;
  addEstimate(db, {
    taskId,
    kind: "planner",
    minutes,
    source: "laya_prior",
    rationale: "size bucket prior",
  });
}
