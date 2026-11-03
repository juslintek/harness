import type { Database } from "bun:sqlite";
import type { AgentSpec } from "../agents/api";
import { checkAction, expireRunApprovals } from "../guard/api";
import { appendEvent, type NewEvent, sealSegments } from "../logs/api";
import { revokeRunTokens } from "../mcp/api";
import { recordQuota, recordUsage } from "../usage/api";
import { runAcp } from "./acp";
import type { Adapter, RunContext, RunOutcome } from "./adapter";
import { runAgy } from "./agy";
import { runApi } from "./api-lane";
import { createBreaker, defaultLimits } from "./breaker";
import { createLaunch, inProcessLaunch, type Launch, type RunDeps, type RunMember } from "./launch";
import { pidIdentity } from "./orphans";
import {
  getFlag,
  getRun,
  hasExpiredApproval,
  insertRun,
  markEnded,
  markRunning,
  type RunRow,
  type RunState,
  setFlag,
  setPid,
  setStarting,
} from "./runs-repo";
import { type Live, stopAll } from "./shutdown";
import { NotAGitRepo } from "./worktree";

export interface StartInput {
  agentId: string;
  repo: string;
  prompt: string;
  model?: string;
  taskId?: string;
  member?: RunMember;
}
const LANES: Record<AgentSpec["lane"], Adapter> = { acp: runAcp, agy: runAgy, api: runApi };
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const APPROVAL_SLACK_MS = 30_000;
const live = new Map<string, Live>();
const waits = new Map<string, Promise<RunRow>>();
const listeners = new Set<(runId: string, e: NewEvent) => void>();

export function isHalted(db: Database): boolean {
  return getFlag(db, "halted") === "1";
}

export function killRun(db: Database, runId: string, reason = "killed_by_user"): boolean {
  const run = live.get(runId);
  if (!run) return false;
  run.killReason ??= reason;
  run.abort.abort();
  expireRunApprovals(db, runId);
  return true;
}

export function setHalted(db: Database, halted: boolean): void {
  setFlag(db, "halted", halted ? "1" : "0");
  if (halted) for (const id of [...live.keys()]) killRun(db, id, "halted");
}

export function shutdownRuns(db: Database, graceMs = 5000): Promise<void> {
  const finish = (id: string, run: Live): void => {
    finalize(db, id, run.agent, "killed", run.killReason ?? "harness_shutdown");
  };
  return stopAll(live, waits, finish, graceMs);
}

export function onRunEvent(listener: (runId: string, e: NewEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function waitForRun(runId: string): Promise<RunRow> {
  return waits.get(runId) ?? Promise.reject(new Error(`unknown run: ${runId}`));
}

function publish(db: Database, runId: string, e: NewEvent): void {
  appendEvent(db, e);
  for (const listener of listeners) {
    try {
      listener(runId, e);
    } catch (err) {
      console.error("run event listener failed", err);
    }
  }
}

function endState(
  db: Database,
  runId: string,
  run: Live,
  o: RunOutcome,
): [RunState, string | null] {
  if (run.killReason !== null) return ["killed", run.killReason];
  if (hasExpiredApproval(db, runId)) return ["blocked", "approval_timeout"];
  switch (o.stopReason) {
    case "end_turn":
      return ["completed", null];
    case "cancelled":
      return run.denied ? ["blocked", "guard_denied"] : ["cancelled", null];
    case "refusal":
    case "max_tokens":
      return ["failed", o.stopReason];
    default:
      return ["failed", o.error ?? o.stopReason];
  }
}

function finalize(
  db: Database,
  id: string,
  agent: string,
  state: RunState,
  reason: string | null,
): RunRow {
  // Shutdown and the lane's own return can both end the same run; the first one wins. Keyed on the
  // stored row, so a first finalize that threw before markEnded still lets the retry through.
  const done = getRun(db, id);
  if (done?.endedAt != null) return done;
  try {
    markEnded(db, id, state, reason);
    const body = reason === null ? state : `${state}: ${reason}`;
    publish(db, id, { kind: "run", runId: id, agent, body });
  } finally {
    try {
      sealSegments(db, { runId: id });
    } finally {
      revokeRunTokens(db, id);
      expireRunApprovals(db, id);
      live.delete(id);
    }
  }
  const row = getRun(db, id);
  if (!row) throw new Error(`run vanished: ${id}`);
  return row;
}

function buildContext(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  input: StartInput & { id: string },
  launch: Launch,
  run: Live,
): RunContext {
  const breaker = createBreaker(deps.breaker ?? defaultLimits());
  const base = {
    runId: input.id,
    agent: spec.id,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  };
  return {
    runId: input.id,
    cwd: launch.worktree ?? input.repo,
    prompt: input.prompt,
    model: input.model ?? null,
    spec,
    argv: launch.argv,
    env: launch.env,
    mcp: launch.mcp,
    claudeSettings: launch.claudeSettings,
    emit(e) {
      const event: NewEvent = { ...base, ...e };
      publish(db, input.id, event);
      if (breaker.record(event) === "trip") killRun(db, input.id, "circuit_breaker");
    },
    async decide(ask) {
      try {
        const out = await checkAction(
          db,
          { id: input.id, prompt: input.prompt, scope: launch.scope },
          ask,
          {
            ...(deps.approvalTimeoutMs === undefined
              ? {}
              : { approvalTimeoutMs: deps.approvalTimeoutMs }),
            onApprovalPending: (approvalId) =>
              publish(db, input.id, { ...base, kind: "approval", body: `pending ${approvalId}` }),
          },
        );
        if (out.verdict === "deny") run.denied = true;
        return out.verdict;
      } catch (err) {
        // A guard that cannot decide must not let the action through.
        run.denied = true;
        publish(db, input.id, { ...base, kind: "error", body: `guard failed: ${String(err)}` });
        return "deny";
      }
    },
    onQuota: (q) => recordQuota(db, { ...q, source: "acp" }),
    onProgress: (p) => {
      if (breaker.addTokens(p.contextTokens) === "trip") killRun(db, input.id, "circuit_breaker");
    },
    onSpawn: (pid) => {
      run.pid = pid;
      setPid(db, input.id, pid, pidIdentity(pid));
    },
    signal: run.abort.signal,
    idleTimeoutMs: deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(deps.approvalTimeoutMs === undefined
      ? {}
      : { decideTimeoutMs: deps.approvalTimeoutMs + APPROVAL_SLACK_MS }),
  };
}

async function execute(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  input: StartInput & { id: string },
  launch: Launch,
  run: Live,
): Promise<RunRow> {
  let state: RunState = "failed";
  let reason: string | null = "internal_error";
  try {
    const outcome = await (deps.lane ?? LANES[spec.lane])(
      buildContext(db, deps, spec, input, launch, run),
    );
    const conversation = outcome.sessionId === null ? {} : { conversationId: outcome.sessionId };
    recordUsage(db, { id: input.id, agent: spec.id, ...conversation }, outcome.usage);
    [state, reason] = endState(db, input.id, run, outcome);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    if (run.killReason !== null) [state, reason] = ["killed", run.killReason];
  }
  return finalize(db, input.id, spec.id, state, reason);
}

async function prepare(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  input: StartInput & { id: string },
): Promise<Launch | { failed: string }> {
  try {
    const launch =
      spec.lane === "api"
        ? inProcessLaunch(input.repo)
        : await createLaunch(db, deps, spec, input.id, input.repo, input.member);
    setStarting(db, input.id, launch.worktree, launch.branch);
    return launch;
  } catch (err) {
    if (err instanceof NotAGitRepo) return { failed: "not_a_git_repo" };
    publish(db, input.id, {
      kind: "error",
      runId: input.id,
      body: `launch failed: ${String(err)}`,
    });
    return { failed: "launch_failed" };
  }
}

export async function startRun(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  input: StartInput,
): Promise<string> {
  const full = { ...input, id: Bun.randomUUIDv7() };
  insertRun(db, {
    id: full.id,
    taskId: input.taskId ?? null,
    member: input.member ?? null,
    agentId: spec.id,
    model: input.model ?? null,
    repo: input.repo,
    prompt: input.prompt,
  });
  const run: Live = {
    abort: new AbortController(),
    killReason: null,
    denied: false,
    agent: spec.id,
    pid: null,
  };
  live.set(full.id, run);
  const launch = await prepare(db, deps, spec, full);
  if ("failed" in launch) {
    waits.set(full.id, Promise.resolve(finalize(db, full.id, spec.id, "failed", launch.failed)));
    return full.id;
  }
  if (isHalted(db)) run.killReason ??= "halted";
  if (run.killReason !== null) {
    waits.set(full.id, Promise.resolve(finalize(db, full.id, spec.id, "killed", run.killReason)));
    return full.id;
  }
  markRunning(db, full.id);
  waits.set(
    full.id,
    execute(db, deps, spec, full, launch, run).catch((err: unknown) => {
      console.error("run crashed outside its lane", err);
      return finalize(db, full.id, spec.id, "failed", "internal_error");
    }),
  );
  return full.id;
}
