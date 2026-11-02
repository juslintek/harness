import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { type AgentSpec, getSpec } from "../agents/api";
import { expireApprovals } from "../guard/api";
import type { NewEvent } from "../logs/api";
import { listAcpModels } from "./acp-models";
import { createProbeLaunch, type RunDeps } from "./launch";
import {
  setHalted as halt,
  isHalted as halted,
  killRun as kill,
  onRunEvent as onEvent,
  startRun as start,
  waitForRun as wait,
} from "./manager";
import { failLiveRuns, getRun as get, listRuns as list, type RunRow } from "./runs-repo";

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
  input: { agentId: string; repo: string; prompt: string; model?: string; taskId?: string },
): Promise<string> {
  if (halted(db)) throw new HaltedError();
  const spec = (deps.resolveSpec ?? getSpec)(input.agentId);
  if (!spec) throw new UnknownAgent(input.agentId);
  return start(db, deps, spec, input);
}

export function killRun(db: Database, runId: string): boolean {
  return kill(db, runId);
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

export function getRun(db: Database, id: string): RunRow | null {
  return get(db, id);
}

export function waitForRun(runId: string): Promise<RunRow> {
  return wait(runId);
}

export function onRunEvent(listener: (runId: string, e: NewEvent) => void): () => void {
  return onEvent(listener);
}

// Live runs and in-process approval waiters do not survive a restart.
export function recoverRuns(db: Database): void {
  failLiveRuns(db, "harness_restart");
  expireApprovals(db, Number.MAX_SAFE_INTEGER);
}

export async function refreshAcpModels(
  deps: RunDeps,
  spec: AgentSpec,
): Promise<Array<{ id: string; name: string }>> {
  const probe = await createProbeLaunch(deps, spec);
  try {
    return await listAcpModels(spec, probe.argv, probe.env, probe.cwd);
  } finally {
    await rm(probe.dir, { recursive: true, force: true });
  }
}
