import type { Database } from "bun:sqlite";
import type { Status, TaskView } from "../../../shared/board";
import { emit, getTask, nextRank } from "./repo";

export type MoveResult =
  | { ok: true; task: TaskView }
  | { ok: false; reason: "held"; holderId: string }
  | { ok: false; reason: "deps_open"; open: number[] }
  | { ok: false; reason: "children_open"; open: number[] }
  | { ok: false; reason: "not_found" };

const OPEN = "status NOT IN ('done', 'cancelled')";
const numbers = (rows: { number: number }[]): number[] => rows.map((r) => r.number);

function openDeps(db: Database, taskId: string): number[] {
  return numbers(
    db
      .query<{ number: number }, [string]>(
        `SELECT t.number FROM tasks t JOIN task_deps d ON d.depends_on = t.id
         WHERE d.task_id = ? AND t.${OPEN} ORDER BY t.number`,
      )
      .all(taskId),
  );
}
function openChildren(db: Database, taskId: string): number[] {
  return numbers(
    db
      .query<{ number: number }, [string]>(
        `SELECT number FROM tasks WHERE parent_id = ? AND ${OPEN} ORDER BY number`,
      )
      .all(taskId),
  );
}

// The result union has no reason for done/cancelled tasks, so they report not_found.
function checkoutFailure(db: Database, taskId: string, memberId: string): MoveResult {
  const task = getTask(db, taskId);
  if (!task || task.status === "done" || task.status === "cancelled") {
    return { ok: false, reason: "not_found" };
  }
  if (task.holderId !== null && task.holderId !== memberId) {
    return { ok: false, reason: "held", holderId: task.holderId };
  }
  return { ok: false, reason: "deps_open", open: openDeps(db, taskId) };
}

function tryCheckout(db: Database, taskId: string, memberId: string): MoveResult {
  const now = Date.now();
  const res = db
    .query(
      `UPDATE tasks SET checked_out_at = CASE WHEN holder_id = ?1 THEN checked_out_at ELSE ?2 END,
         holder_id = ?1, status = 'in_progress', updated_at = ?2
       WHERE id = ?3 AND (holder_id IS NULL OR holder_id = ?1) AND ${OPEN}
         AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks t ON t.id = d.depends_on
                         WHERE d.task_id = tasks.id AND t.${OPEN})`,
    )
    .run(memberId, now, taskId);
  if (res.changes === 0) return checkoutFailure(db, taskId, memberId);
  return { ok: true, task: getTask(db, taskId) as TaskView };
}

export function checkout(db: Database, taskId: string, memberId: string): MoveResult {
  const r = tryCheckout(db, taskId, memberId);
  if (r.ok) emit({ kind: "checked_out", task: r.task, by: memberId });
  return r;
}

export function release(db: Database, taskId: string, memberId: string): MoveResult {
  const res = db
    .query(
      "UPDATE tasks SET holder_id = NULL, checked_out_at = NULL, updated_at = ? WHERE id = ? AND holder_id = ?",
    )
    .run(Date.now(), taskId, memberId);
  if (res.changes === 0) {
    const task = getTask(db, taskId);
    if (!task) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "held", holderId: task.holderId ?? "" };
  }
  const task = getTask(db, taskId) as TaskView;
  emit({ kind: "released", task, by: memberId });
  return { ok: true, task };
}

function rankFor(db: Database, task: TaskView, to: Status, beforeId?: string): number {
  const before = beforeId === undefined ? null : getTask(db, beforeId);
  if (!before || before.projectId !== task.projectId) return nextRank(db, task.projectId, to);
  const prev = db
    .query<{ m: number | null }, [string, string, number, string]>(
      "SELECT MAX(rank) AS m FROM tasks WHERE project_id = ? AND status = ? AND rank < ? AND id <> ?",
    )
    .get(task.projectId, before.status, before.rank, task.id);
  return prev?.m == null ? before.rank - 1 : (prev.m + before.rank) / 2;
}

function applyMove(db: Database, taskId: string, to: Status, rank: number): void {
  const keep = to === "in_review" || to === "blocked" || to === "in_progress" ? 1 : 0;
  db.query(
    `UPDATE tasks SET status = ?1, rank = ?2, updated_at = ?3,
       holder_id = CASE WHEN ?4 THEN holder_id END,
       checked_out_at = CASE WHEN ?4 THEN checked_out_at END WHERE id = ?5`,
  ).run(to, rank, Date.now(), keep, taskId);
}

function tryMove(db: Database, taskId: string, to: Status, by: string, beforeId?: string) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, reason: "not_found" } as const;
  if (task.holderId !== null && task.holderId !== by) {
    return { ok: false, reason: "held", holderId: task.holderId } as const;
  }
  if (to === "in_progress") {
    const r = tryCheckout(db, taskId, by);
    if (!r.ok) return r;
  } else if (to === "done") {
    const open = openChildren(db, taskId);
    if (open.length > 0) return { ok: false, reason: "children_open", open } as const;
  }
  applyMove(db, taskId, to, rankFor(db, task, to, beforeId));
  return { ok: true, task: getTask(db, taskId) as TaskView } as const;
}

export function moveTask(
  db: Database,
  taskId: string,
  to: Status,
  by: string,
  opts: { beforeId?: string } = {},
): MoveResult {
  const r: MoveResult = db.transaction(() => tryMove(db, taskId, to, by, opts.beforeId))();
  if (r.ok) emit({ kind: "moved", task: r.task, by });
  return r;
}
