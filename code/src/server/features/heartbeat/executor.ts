import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getTask } from "../board/api";
import { budgetGate } from "../budgets/api";
import { getMember, getProject, type MemberRow } from "../orgs/api";
import { handoffSummary, linkRouteDecision, routeOutcome } from "../router/api";
import { getRun, HaltedError, isHalted, type RunRow, scratchRepo, startRun } from "../runtimes/api";
import { mcpOnly, memoryRun } from "./memory-notice";
import { parkWakes } from "./park";
import { buildPrompt, MAX_WAKES } from "./prompt";
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

// Retro and lesson-review wakes carry their own prompt and tool set, so they never share a run
// with other reasons: a batch is one memory reason or only work wakes.
function lane(w: WakeRow): string {
  return w.reason === "retro" || w.reason === "lesson_review" ? w.reason : "work";
}

// A wake stored before a grant was revoked or lowered must not start a run in that project.
// One run works in one project's repo and is judged by that project's org, so it takes only the
// wakes of the oldest wake's project and lane; the others wait for the next batch. A memory-only
// prompt lists at most MAX_WAKES wakes, so a larger batch would mark wakes done that the agent
// was never shown.
export function nextBatch(
  db: Database,
  memberId: string,
): { wakes: WakeRow[]; projectId: string | null } {
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
  const same = (w: WakeRow): boolean =>
    wakeProject(db, w) === projectId && first !== undefined && lane(w) === lane(first);
  const batch = reachable.filter(same);
  const memoryOnly = first !== undefined && lane(first) !== "work";
  return { wakes: memoryOnly ? batch.slice(0, MAX_WAKES) : batch, projectId };
}

interface Batch {
  ids: string[];
  wakes: WakeRow[];
  projectId: string | null;
}

type StartResult = { kind: "started"; runId: string } | { kind: "parked" } | { kind: "failed" };

function parkedOriginRun(db: Database, wakes: WakeRow[]): RunRow | null {
  for (const w of wakes) {
    const detail = w.detail as { parkedFromRunId?: unknown } | null;
    if (typeof detail?.parkedFromRunId !== "string") continue;
    const prev = getRun(db, detail.parkedFromRunId);
    if (prev?.worktree && prev.branch && existsSync(prev.worktree)) return prev;
  }
  return null;
}

async function startFirst(
  db: Database,
  deps: ExecDeps,
  member: MemberRow,
  batch: Batch,
): Promise<StartResult> {
  const taskId = batch.wakes.find((w) => w.taskId !== null && getTask(db, w.taskId))?.taskId;
  const runtimeFilter = mcpOnly(deps, batch.wakes);
  const { choices, poolExhausted, decisionId } = await routeOutcome(
    db,
    { memberId: member.id, taskId, runtimeFilter },
    deps.routeDeps,
  );
  const [choice] = choices;
  if (!choice) {
    if (poolExhausted !== null) {
      parkWakes(db, member, batch.ids, poolExhausted.retryAt);
      return { kind: "parked" };
    }
    const reason = runtimeFilter ? "no engine with MCP for a memory-only run" : "no engine";
    setStatus(db, batch.ids, "failed", { detail: { route: reason } });
    return { kind: "failed" };
  }
  const { runtime, model, accountId } = choice.engine;
  const prev = parkedOriginRun(db, batch.wakes);
  const repo = batch.projectId === null ? null : (getProject(db, batch.projectId)?.repo ?? null);
  const mem = memoryRun(db, deps, member, runtime, batch.projectId, batch.wakes);
  const basePrompt = buildPrompt(db, member, batch.wakes, mem.mcp, mem.index !== undefined);
  const prompt = prev ? `${await handoffSummary(db, prev)}\n\n${basePrompt}` : basePrompt;
  const runId = await startRun(db, deps.runDeps, {
    agentId: runtime,
    ...(model === null ? {} : { model }),
    ...(accountId == null ? {} : { accountId }),
    repo: prev ? prev.repo : (repo ?? scratchRepo(deps.home, member.orgId)),
    prompt,
    ...(taskId == null ? {} : { taskId }),
    member: runMember(db, member, batch.projectId, mem.index),
    ...(prev ? { reuseWorktreeOf: prev.id } : {}),
    attempt: 1,
    batchId: batch.ids[0] as string,
  });
  if (decisionId !== null) linkRouteDecision(db, decisionId, runId);
  return { kind: "started", runId };
}

// "retry" means the batch was marked failed at routing, so the member's next pending batch is
// still waiting for this pass.
async function launchBatch(
  db: Database,
  deps: ExecDeps,
  memberId: string,
): Promise<boolean | "retry"> {
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
    const started = await startFirst(db, deps, member, { ids, wakes, projectId });
    if (started.kind === "failed") return "retry";
    if (started.kind === "parked") return false;
    setStatus(db, ids, "started", { runId: started.runId, detail: { parkedFromRunId: null } });
    await settleRun(db, deps, started.runId);
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

// Each retry marks its batch failed, so a pass takes at most one round per pending wake.
async function launch(db: Database, deps: ExecDeps, memberId: string): Promise<boolean> {
  for (let left = pendingWakes(db, memberId).length; left > 0; left--) {
    const outcome = await launchBatch(db, deps, memberId);
    if (outcome !== "retry") return outcome;
  }
  return false;
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
