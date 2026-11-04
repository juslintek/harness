import type { Database } from "bun:sqlite";
import { getTask, taskDetail } from "../board/api";
import { directReportsOf } from "../orgs/api";
import type { RunRow } from "../runtimes/api";
import { hasNudge, type WakeRow } from "./repo";
import { recordWake } from "./triggers";

// A manager that ends an assignment without splitting it has done the work itself or given up;
// one more wake says so. Once per task, so a manager that really cannot split it is left alone.
export function nudgeUndelegated(db: Database, run: RunRow, wakes: WakeRow[]): void {
  const { memberId } = run;
  if (run.state !== "completed" || memberId === null) return;
  if (directReportsOf(db, memberId).length === 0) return;
  for (const taskId of new Set(
    wakes.filter((w) => w.reason === "assignment").map((w) => w.taskId),
  )) {
    const task = taskId === null ? null : getTask(db, taskId);
    if (!task || task.status === "done" || task.status === "cancelled") continue;
    if (task.assigneeId !== memberId || taskDetail(db, task.id).subtasks.length > 0) continue;
    if (hasNudge(db, task.id)) continue;
    recordWake(db, {
      memberId,
      reason: "assignment",
      taskId: task.id,
      causedBy: null,
      detail: { nudge: "delegate" },
    });
  }
}
