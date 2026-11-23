import type { Database } from "bun:sqlite";
import { budgetGate } from "../budgets/api";
import { appendEvent } from "../logs/api";
import { getMember } from "../orgs/api";
import {
  type FailoverDecision,
  linkHandoff,
  type NextAttempt,
  nextAttemptOrPark,
} from "../router/api";
import { getRun, type RunRow, ShuttingDownError, startRun } from "../runtimes/api";
import { mcpOnly, memoryRun } from "./memory-notice";
import { nudgeUndelegated } from "./nudge";
import { parkWakes } from "./park";
import { buildPrompt } from "./prompt";
import { setStatus, startedWakesOf, type WakeRow } from "./repo";
import { type ExecDeps, fail, runMember, wakeProject } from "./run-input";

// A paused member or budget means the run was stopped on purpose, so no other engine takes over.
async function chooseNext(
  db: Database,
  deps: ExecDeps,
  run: RunRow,
  wakes: WakeRow[],
): Promise<FailoverDecision> {
  if (run.state === "completed" || run.memberId === null) return { kind: "none" };
  if (getMember(db, run.memberId)?.paused) return { kind: "none" };
  if (budgetGate(db, run.memberId).state === "paused") return { kind: "none" };
  try {
    return await nextAttemptOrPark(db, run.id, deps.routeDeps, mcpOnly(deps, wakes));
  } catch (err) {
    // A routing fault must not leave the wakes started on a run that is already over.
    appendEvent(db, {
      kind: "error",
      source: "heartbeat",
      body: `failover of run ${run.id} failed: ${String(err)}`,
    });
    return { kind: "none" };
  }
}

async function startNext(
  db: Database,
  deps: ExecDeps,
  run: RunRow,
  wakes: WakeRow[],
  next: NextAttempt,
): Promise<string> {
  const member = run.memberId === null ? null : getMember(db, run.memberId);
  if (!member) throw new Error("member is gone");
  const [first] = wakes;
  const projectId = first ? wakeProject(db, first) : null;
  const mem = memoryRun(db, deps, member, next.engine.runtime, projectId, wakes);
  const runId = await startRun(db, deps.runDeps, {
    agentId: next.engine.runtime,
    ...(next.engine.model === null ? {} : { model: next.engine.model }),
    ...(next.engine.accountId == null ? {} : { accountId: next.engine.accountId }),
    repo: run.repo,
    prompt: `${next.summary}\n\n${buildPrompt(db, member, wakes, mem.mcp, mem.index !== undefined)}`,
    ...(run.taskId === null ? {} : { taskId: run.taskId }),
    member: runMember(db, member, projectId, mem.index),
    reuseWorktreeOf: next.reuseWorktreeOf,
    attempt: run.attempt + 1,
    batchId: run.batchId ?? run.id,
  });
  return runId;
}

async function continueWithNext(
  db: Database,
  deps: ExecDeps,
  run: RunRow,
  wakes: WakeRow[],
  ids: string[],
  next: NextAttempt,
): Promise<void> {
  let nextRunId: string;
  try {
    nextRunId = await startNext(db, deps, run, wakes, next);
  } catch (err) {
    // The wakes go back in the queue for the next boot; a refusal is not a failure of the work.
    if (err instanceof ShuttingDownError) setStatus(db, ids, "pending");
    else fail(db, ids, err);
    return;
  }
  // The new run is live whether or not the link is written, so a failure here only loses the audit row.
  try {
    linkHandoff(db, next.handoffId, nextRunId);
  } catch (err) {
    appendEvent(db, {
      kind: "error",
      source: "heartbeat",
      body: `handoff ${next.handoffId} not linked to run ${nextRunId}: ${String(err)}`,
    });
  }
  setStatus(db, ids, "started", { runId: nextRunId });
  await settleRun(db, deps, nextRunId);
}

// The run can end before startRun's caller has recorded the run id, so the state is read here
// as well as on the run event. A failed run hands its wakes to the next engine; only when there is
// none do the wakes settle. Callers run one settle at a time (the heartbeat chain), and the handoff
// row is what stops a second path from starting a second continuation.
export async function settleRun(db: Database, deps: ExecDeps, runId: string): Promise<void> {
  const run = getRun(db, runId);
  const wakes = startedWakesOf(db, runId);
  const ids = wakes.map((w) => w.id);
  if (ids.length === 0) return;
  if (!run) {
    setStatus(db, ids, "failed", { detail: { state: "missing" } });
    return;
  }
  if (run.endedAt === null) return;
  const decision = await chooseNext(db, deps, run, wakes);
  if (decision.kind === "park") {
    const member = run.memberId === null ? null : getMember(db, run.memberId);
    if (member) {
      parkWakes(db, member, ids, decision.retryAt);
      return;
    }
  }
  if (decision.kind === "next") {
    await continueWithNext(db, deps, run, wakes, ids, decision.attempt);
    return;
  }
  const detail = { state: run.state, reason: run.reason };
  setStatus(db, ids, run.state === "completed" ? "done" : "failed", { detail });
  nudgeUndelegated(db, run, wakes);
}
