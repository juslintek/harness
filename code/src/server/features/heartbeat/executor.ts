import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../git-env";
import { getTask } from "../board/api";
import { getChannel } from "../chat/api";
import { appendEvent } from "../logs/api";
import type { TokenScope } from "../mcp/api";
import { getMember, getProject, type MemberRow, managerPositionsOf } from "../orgs/api";
import { getRun, HaltedError, isHalted, type RunDeps, startRun } from "../runtimes/api";
import { buildPrompt } from "./prompt";
import {
  endedStartedRuns,
  hasLiveWake,
  membersWithPending,
  pendingWakes,
  setStatus,
  type WakeRow,
  wakesOfRun,
} from "./repo";
import { mayWork, overCap } from "./triggers";

export interface ExecDeps {
  runDeps: RunDeps;
  home: string;
}

function git(args: string[], cwd: string): void {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=harness", "-c", "user.email=harness@localhost", ...args],
    { cwd, env: gitEnv() },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

// A worktree needs a commit to branch from, so the shared scratch repo starts with an empty one.
function scratchRepo(home: string, orgId: string): string {
  const dir = join(home, "scratch", orgId);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
  }
  return dir;
}

function wakeProject(db: Database, wake: WakeRow): string | null {
  const task = wake.taskId === null ? null : getTask(db, wake.taskId);
  const channel = wake.channelId === null ? null : getChannel(db, wake.channelId);
  return task?.projectId ?? channel?.projectId ?? null;
}

function scopesFor(db: Database, member: MemberRow): TokenScope[] {
  const scopes: TokenScope[] = ["report", "guard_hook", "board", "chat"];
  if (managerPositionsOf(db, member.id).length > 0) scopes.push("approvals_decide");
  return scopes;
}

function fail(db: Database, ids: string[], err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(db, ids, "failed", { detail: { error: message } });
  appendEvent(db, { kind: "error", source: "heartbeat", body: `wake run failed: ${message}` });
}

// The run can end before startRun's caller has recorded the run id, so the state is read here
// as well as on the run event.
export function settleRun(db: Database, runId: string): void {
  const run = getRun(db, runId);
  const ids = wakesOfRun(db, runId);
  if (!run) {
    setStatus(db, ids, "failed", { detail: { state: "missing" } });
    return;
  }
  if (run.endedAt === null) return;
  const detail = { state: run.state, reason: run.reason };
  setStatus(db, ids, run.state === "completed" ? "done" : "failed", { detail });
}

// A wake stored before a grant was revoked or lowered must not start a run in that project.
// One run works in one project's repo and is judged by that project's org, so it takes only the
// wakes of the oldest wake's project; the others wait for the next batch.
function nextBatch(db: Database, memberId: string): { wakes: WakeRow[]; projectId: string | null } {
  const wakes = pendingWakes(db, memberId);
  const lost = wakes.filter((w) => !mayWork(db, memberId, w));
  setStatus(
    db,
    lost.map((w) => w.id),
    "skipped",
    { detail: { reason: "no_access" } },
  );
  const reachable = wakes.filter((w) => !lost.includes(w));
  const first = reachable[0];
  const projectId = first ? wakeProject(db, first) : null;
  return { wakes: reachable.filter((w) => wakeProject(db, w) === projectId), projectId };
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
  if (overCap(db, memberId)) {
    setStatus(db, ids, "skipped", { detail: { cap: "hourly" } });
    return false;
  }
  setStatus(db, ids, "started");
  const repo = projectId === null ? null : (getProject(db, projectId)?.repo ?? null);
  const taskId = wakes.find((w) => w.taskId !== null && getTask(db, w.taskId))?.taskId;
  try {
    const runId = await startRun(db, deps.runDeps, {
      agentId: member.agentId,
      ...(member.model === null ? {} : { model: member.model }),
      repo: repo ?? scratchRepo(deps.home, member.orgId),
      prompt: buildPrompt(db, member, wakes),
      ...(taskId == null ? {} : { taskId }),
      member: {
        memberId,
        orgId: member.orgId,
        scopes: scopesFor(db, member),
        ...(projectId === null ? {} : { projectId }),
      },
    });
    setStatus(db, ids, "started", { runId });
    settleRun(db, runId);
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
export function sweepEnded(db: Database): boolean {
  const runs = endedStartedRuns(db);
  for (const runId of runs) settleRun(db, runId);
  return runs.length > 0;
}
