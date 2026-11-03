import type { Database } from "bun:sqlite";
import { getTask } from "../board/api";
import { budgetGate } from "../budgets/api";
import { getMember, getProject, type MemberRow } from "../orgs/api";
import { route } from "../router/api";
import { HaltedError, isHalted, scratchRepo, startRun } from "../runtimes/api";
import { buildPrompt } from "./prompt";
import {
  endedStartedRuns,
  hasLiveWake,
  membersWithPending,
  pendingWakes,
  setStatus,
  type WakeRow,
} from "./repo";
import { type ExecDeps, fail, runMember, wakeProject } from "./run-input";
import { settleRun } from "./settle";
import { logBudgetPaused, mayWork, overCap, staleAssignment } from "./triggers";

// A wake stored before a grant was revoked or lowered must not start a run in that project.
// One run works in one project's repo and is judged by that project's org, so it takes only the
// wakes of the oldest wake's project; the others wait for the next batch.
function nextBatch(db: Database, memberId: string): { wakes: WakeRow[]; projectId: string | null } {
  const wakes = pendingWakes(db, memberId);
  if (getMember(db, memberId)?.role === "viewer") {
    setStatus(
      db,
      wakes.map((w) => w.id),
      "skipped",
      { detail: { reason: "viewer" } },
    );
    return { wakes: [], projectId: null };
  }
  const lost = wakes.filter((w) => !mayWork(db, memberId, w));
  setStatus(
    db,
    lost.map((w) => w.id),
    "skipped",
    { detail: { reason: "no_access" } },
  );
  const kept = wakes.filter((w) => !lost.includes(w));
  const stale = kept.filter((w) => staleAssignment(db, memberId, w));
  setStatus(
    db,
    stale.map((w) => w.id),
    "skipped",
    { detail: { reason: "stale" } },
  );
  const reachable = kept.filter((w) => !stale.includes(w));
  const first = reachable[0];
  const projectId = first ? wakeProject(db, first) : null;
  return { wakes: reachable.filter((w) => wakeProject(db, w) === projectId), projectId };
}

interface Batch {
  ids: string[];
  wakes: WakeRow[];
  projectId: string | null;
}

// Null when no engine can take the run, with the wakes already marked failed.
async function startFirst(
  db: Database,
  deps: ExecDeps,
  member: MemberRow,
  batch: Batch,
): Promise<string | null> {
  const taskId = batch.wakes.find((w) => w.taskId !== null && getTask(db, w.taskId))?.taskId;
  const [choice] = await route(db, { memberId: member.id, taskId }, deps.routeDeps);
  if (!choice) {
    setStatus(db, batch.ids, "failed", { detail: { route: "no engine" } });
    return null;
  }
  const { runtime, model } = choice.engine;
  const repo = batch.projectId === null ? null : (getProject(db, batch.projectId)?.repo ?? null);
  return startRun(db, deps.runDeps, {
    agentId: runtime,
    ...(model === null ? {} : { model }),
    repo: repo ?? scratchRepo(deps.home, member.orgId),
    prompt: buildPrompt(db, member, batch.wakes),
    ...(taskId == null ? {} : { taskId }),
    member: runMember(db, member, batch.projectId),
    attempt: 1,
    batchId: batch.ids[0] as string,
  });
}

async function launch(db: Database, deps: ExecDeps, memberId: string): Promise<boolean> {
  const member = getMember(db, memberId);
  const { wakes, projectId } = nextBatch(db, memberId);
  if (wakes.length === 0) return false;
  const ids = wakes.map((w) => w.id);
  if (!member || member.agentId === null || member.paused) {
    setStatus(db, ids, "skipped", { detail: { reason: "member cannot run" } });
    return false;
  }
  if (budgetGate(db, memberId).state === "paused") {
    logBudgetPaused(db, member);
    setStatus(db, ids, "skipped", { detail: { budget: "paused" } });
    return false;
  }
  if (overCap(db, memberId)) {
    setStatus(db, ids, "skipped", { detail: { cap: "hourly" } });
    return false;
  }
  setStatus(db, ids, "started");
  try {
    const runId = await startFirst(db, deps, member, { ids, wakes, projectId });
    if (runId === null) return false;
    setStatus(db, ids, "started", { runId });
    await settleRun(db, deps, runId);
    return false;
  } catch (err) {
    if (err instanceof HaltedError) {
      setStatus(db, ids, "pending");
      return true;
    }
    fail(db, ids, err);
    return false;
  }
}

// Every member with pending wakes and no live run gets one run for the whole batch.
// Returns true when something had to wait for the harness to be un-halted.
export async function runPending(db: Database, deps: ExecDeps): Promise<boolean> {
  let deferred = false;
  for (const memberId of membersWithPending(db)) {
    if (hasLiveWake(db, memberId)) continue;
    if (isHalted(db)) return true;
    deferred = (await launch(db, deps, memberId)) || deferred;
  }
  return deferred;
}

// Settles wakes whose run ended without an event reaching us; true when it changed anything.
export async function sweepEnded(db: Database, deps: ExecDeps): Promise<void> {
  for (const runId of endedStartedRuns(db)) await settleRun(db, deps, runId);
}
