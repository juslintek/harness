import type { Database } from "bun:sqlite";
import { type Engine, QUOTA_PROVIDER } from "../../../shared/router";
import { contextForMember, effective } from "../policies/api";
import { getRun, killRun, liveRuns, type RunRow } from "../runtimes/api";
import { onQuotaRecorded } from "../usage/api";
import { type RouteDeps, route } from "./candidates";
import { handoffSummary } from "./handoff";

export interface NextAttempt {
  engine: Engine;
  handoffId: string;
  summary: string;
  reuseWorktreeOf: string;
}

const MAX_ATTEMPTS = 3;

// Everything else that ends a run (user kill, halt, guard denial, approval timeout, spent budget) is a
// decision to stop, not a fault of the engine.
function failsOver(run: RunRow): boolean {
  if (run.state === "failed") return run.reason !== "budget_exhausted";
  return run.state === "killed" && run.reason === "quota_exhausted";
}

function triedIn(db: Database, batchId: string): Engine[] {
  return db
    .query<{ agent_id: string; model: string | null }, [string, string]>(
      "SELECT agent_id, model FROM runs WHERE batch_id = ? OR id = ?",
    )
    .all(batchId, batchId)
    .map((r) => ({ runtime: r.agent_id, model: r.model }));
}

// Two paths can end the same run (the quota watchdog and the run's own error); the unique handoff per
// failed run lets only one of them continue.
export async function nextAttempt(
  db: Database,
  endedRunId: string,
  deps?: RouteDeps,
): Promise<NextAttempt | null> {
  const run = getRun(db, endedRunId);
  if (!run?.memberId || !run.worktree || !failsOver(run) || run.attempt >= MAX_ATTEMPTS) {
    return null;
  }
  const ctx = contextForMember(db, run.memberId, run.taskId ?? undefined);
  if (!effective(db, ctx, "router.failover").value) return null;
  const batchId = run.batchId ?? run.id;
  const [next] = await route(
    db,
    { memberId: run.memberId, taskId: run.taskId, exclude: triedIn(db, batchId) },
    deps,
  );
  if (!next) return null;
  const summary = handoffSummary(db, run);
  const handoffId = Bun.randomUUIDv7();
  const inserted = db.run(
    `INSERT INTO run_handoffs (id, batch_id, task_id, member_id, from_run_id, reason, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(from_run_id) DO NOTHING`,
    [
      handoffId,
      batchId,
      run.taskId,
      run.memberId,
      run.id,
      run.reason ?? run.state,
      summary,
      Date.now(),
    ],
  );
  if (inserted.changes === 0) return null;
  return { engine: next.engine, handoffId, summary, reuseWorktreeOf: run.id };
}

export function linkHandoff(db: Database, handoffId: string, toRunId: string): void {
  db.run("UPDATE run_handoffs SET to_run_id = ? WHERE id = ?", [toRunId, handoffId]);
}

// Every live run of the exhausted provider stops at once; its own error path would only get there later.
// A snapshot read back from old logs can say 100% for a window that has long reset, so it is ignored.
export function startWatchdog(db: Database): () => void {
  return onQuotaRecorded((q) => {
    if (q.usedPercent === null || q.usedPercent < 100) return;
    if (q.resetsAt !== null && q.resetsAt <= Date.now()) return;
    for (const run of liveRuns(db)) {
      if (QUOTA_PROVIDER[run.agentId] === q.provider) killRun(db, run.id, "quota_exhausted");
    }
  });
}
