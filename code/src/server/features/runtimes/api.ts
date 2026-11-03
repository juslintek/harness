import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSpec, getSpec } from "../agents/api";
import { releaseHeldBy } from "../board/api";
import { expireApprovals } from "../guard/api";
import type { NewEvent } from "../logs/api";
import { onGrantChanged, onMemberDemoted, onMemberRemoved } from "../orgs/api";
import { listAcpModels } from "./acp-models";
import { createProbeLaunch, type RunCandidate, type RunDeps, type RunMember } from "./launch";
import {
  setHalted as halt,
  isHalted as halted,
  killRun as kill,
  onRunEvent as onEvent,
  shutdownRuns as shutdown,
  startRun as start,
  waitForRun as wait,
} from "./manager";
import { reapRuns } from "./orphans";
import { getRun as get, listRuns as list, listLiveRuns, type RunRow } from "./runs-repo";
import { scratchRepo as scratch } from "./scratch";
import { defaultBranch as defaultBranchOf } from "./worktree";

export type { RunDeps } from "./launch";
export type { RunRow } from "./runs-repo";

export class HaltedError extends Error {
  constructor() {
    super("harness is halted");
    this.name = "HaltedError";
  }
}

export class UnknownAgent extends Error {
  constructor(id: string) {
    super(`unknown agent: ${id}`);
    this.name = "UnknownAgent";
  }
}

export async function startRun(
  db: Database,
  deps: RunDeps,
  input: {
    agentId: string;
    repo: string;
    prompt: string;
    model?: string;
    taskId?: string;
    member?: RunMember;
    candidate?: RunCandidate;
    reuseWorktreeOf?: string;
    attempt?: number;
    batchId?: string;
  },
): Promise<string> {
  if (halted(db)) throw new HaltedError();
  const spec = (deps.resolveSpec ?? getSpec)(input.agentId);
  if (!spec) throw new UnknownAgent(input.agentId);
  return start(db, deps, spec, input);
}

export function killRun(db: Database, runId: string, reason?: string): boolean {
  return kill(db, runId, reason);
}

// A removed or demoted agent must stop at once: killing the run makes finalize revoke its run token, which
// would otherwise keep the member's board and chat scopes until the run ends on its own.
function endRunsOf(db: Database, memberId: string, reason = "member_removed"): void {
  const ids = db
    .query<{ id: string }, [string]>("SELECT id FROM runs WHERE member_id = ? AND ended_at IS NULL")
    .all(memberId);
  for (const { id } of ids) kill(db, id, reason);
}

// A grantee org's agents must stop working in a project once their org lost write access to it,
// and the tasks they held there go back to the pool.
function endRunsOnGrant(db: Database, projectId: string, orgId: string): void {
  const ids = db
    .query<{ id: string }, [string, string]>(
      `SELECT r.id FROM runs r JOIN members m ON m.id = r.member_id
       WHERE r.project_id = ? AND m.org_id = ? AND r.ended_at IS NULL`,
    )
    .all(projectId, orgId);
  for (const { id } of ids) kill(db, id, "grant_changed");
  releaseHeldBy(db, projectId, orgId);
}

let wired = false;

// The listener gets the db from the event, so one subscription serves every database.
export function wireRuntimes(): void {
  if (wired) return;
  wired = true;
  onMemberRemoved((db, member) => endRunsOf(db, member.id));
  onMemberDemoted((db, member) => endRunsOf(db, member.id, "member_demoted"));
  onGrantChanged((db, change) => {
    if (change.permission !== "write") endRunsOnGrant(db, change.projectId, change.orgId);
  });
}

export function setHalted(db: Database, value: boolean): void {
  halt(db, value);
}

export function isHalted(db: Database): boolean {
  return halted(db);
}

export function listRuns(db: Database, limit?: number): RunRow[] {
  return list(db, limit);
}

export function defaultBranch(repo: string): Promise<string> {
  return defaultBranchOf(repo);
}

export function getRun(db: Database, id: string): RunRow | null {
  return get(db, id);
}

export function liveRuns(db: Database): RunRow[] {
  return listLiveRuns(db);
}

export function waitForRun(runId: string): Promise<RunRow> {
  return wait(runId);
}

export function onRunEvent(listener: (runId: string, e: NewEvent) => void): () => void {
  return onEvent(listener);
}

export function shutdownRuns(db: Database, graceMs?: number): Promise<void> {
  return shutdown(db, graceMs);
}

export function recoverRuns(db: Database): void {
  reapRuns(db);
  expireApprovals(db, Number.MAX_SAFE_INTEGER);
}

export async function refreshAcpModels(
  deps: RunDeps,
  spec: AgentSpec,
): Promise<Array<{ id: string; name: string }>> {
  const dir = join(deps.home, "model-probes", Bun.randomUUIDv7());
  try {
    const probe = await createProbeLaunch(deps, spec, dir);
    return await listAcpModels(spec, probe.argv, probe.env, probe.cwd);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function scratchRepo(home: string, orgId: string): string {
  return scratch(home, orgId);
}
