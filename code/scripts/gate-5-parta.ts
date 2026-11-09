// Part A of the Phase 5 gate: no human, no real accounts. One real Codex run raises an L3 approval
// and every channel, the HTTP decision, the OAuth client and the Desktop link are checked around it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../src/server/features/agents/api";
import { listAgents } from "../src/server/features/agents/api";
import { listApprovals } from "../src/server/features/guard/api";
import { startHeartbeat } from "../src/server/features/heartbeat/api";
import { listRunEvents, redact } from "../src/server/features/logs/api";
import { addAgentMember, listOrgsForUser, memberForUser } from "../src/server/features/orgs/api";
import {
  getRun,
  killRun,
  type RunDeps,
  shutdownRuns,
  startRun,
  waitForRun,
} from "../src/server/features/runtimes/api";
import { git } from "./gate-2-kit";
import {
  checkChannels,
  configureTargets,
  decideOverHttp,
  type Mocks,
  startMocks,
  type World,
} from "./gate-5-checks";
import {
  bootInstance,
  createReport,
  enrollAdmin,
  type Instance,
  signIn,
  stepUp,
  waitFor,
} from "./gate-5-kit";
import { checkDesktopLink, checkOauthAndMcp } from "./gate-5-mcp";

export const ASSERTIONS = 9;
const ASK = "git branch -D gate5-old";
// An L1 ask (force-deleting a branch), so the guard raises an L3 approval before anything runs.
const CODEX_PROMPT = `Run exactly this one shell command and nothing else: ${ASK}\nThen answer with the single word done. It is fine if the command reports an error.`;
const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

export function partAMode(argv: string[]): "fake" | "real" {
  if (argv.includes("--fake") && argv.includes("--real")) {
    throw new Error("--fake and --real cannot be used together");
  }
  return argv.includes("--fake") ? "fake" : "real";
}

const fakeSpec: AgentSpec = {
  id: "fake",
  name: "Fake",
  lane: "acp",
  bin: process.execPath,
  args: [FAKE],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  mcp: true,
};

export interface Lane {
  agentId: string;
  prompt: string;
  model?: string;
  deps: Partial<RunDeps>;
}

// The scripted agent runs through the same launch, sandbox and guard as a real one.
export function fakeLane(script: unknown[]): Lane {
  return {
    agentId: "fake",
    prompt: "go",
    deps: {
      resolveSpec: (id) => (id === "fake" ? fakeSpec : null),
      idleTimeoutMs: 20_000,
      agentEnv: (runDir) => ({
        FAKE_AGENT_SCRIPT: JSON.stringify(script),
        FAKE_AGENT_PIDFILE: join(runDir, "tmp", "pid"),
      }),
    },
  };
}

export const askThenSay = (command: string): unknown[] => [{ ask: { command } }, { say: "after" }];

export function scratchRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "README.md"), "# gate5\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

function pendingFor(inst: Instance, runId: string): Promise<string> {
  return waitFor(
    "a pending approval",
    () => {
      const approval = listApprovals(inst.db, "pending").find((a) => a.runId === runId);
      if (approval) return approval.id;
      const run = getRun(inst.db, runId);
      if (run && ["completed", "failed", "blocked", "cancelled", "killed"].includes(run.state)) {
        throw new Error(
          `run ended before approval (${run.state}): ${redact(run.reason ?? "no reason")}`,
        );
      }
      return undefined;
    },
    300_000,
  );
}

function startOn(w: World, lane: Lane, memberId: string): Promise<string> {
  const deps = { home: w.inst.home, port: w.inst.port, ...lane.deps };
  return startRun(w.inst.db, deps, {
    agentId: lane.agentId,
    repo: w.repo,
    prompt: lane.prompt,
    ...(lane.model === undefined ? {} : { model: lane.model }),
    member: { memberId, orgId: w.orgId, scopes: ["report", "guard_hook"] },
  });
}

function addMember(w: World, agentId: string, handle: string, model?: string): string {
  return addAgentMember(w.inst.db, w.orgId, {
    agentId,
    handle,
    displayName: handle,
    specialties: [],
    ...(model === undefined ? {} : { model }),
  }).id;
}

// Assertion 6 together with 1 to 5: the run is held by the approval, goes on after it, and ends.
async function mainScenario(w: World, lane: Lane): Promise<void> {
  const runId = await startOn(w, lane, addMember(w, lane.agentId, "gate-agent", lane.model));
  const approvalId = await pendingFor(w.inst, runId);
  w.report.check(
    6,
    listRunEvents(w.inst.db, runId).some((e) => e.guardLayer === "L1" && e.guardVerdict === "ask"),
    "the run's first action raised an L1 ask, so an L3 approval",
  );
  await checkChannels(w, approvalId);
  await decideOverHttp(w, approvalId);
  const row = await waitForRun(runId);
  const allowed = listRunEvents(w.inst.db, runId).some(
    (e) => e.guardLayer === "L3" && e.guardVerdict === "allow",
  );
  w.report.check(
    6,
    row.state === "completed" && allowed,
    `the run continued after the approval and ended (${row.state} ${row.reason ?? ""})`,
  );
}

function approvalWakes(w: World, memberId: string, approvalId: string): number {
  const row = w.inst.db
    .query<{ n: number }, [string, string]>(
      `SELECT count(*) AS n FROM wakeups WHERE member_id = ? AND reason = 'approval_resolved'
         AND json_extract(detail, '$.approval') = ?`,
    )
    .get(memberId, approvalId);
  return row?.n ?? 0;
}

// Assertion 7: a run whose approval is still open when the run is killed. Scripted agent, because
// the guard path is the same and no tokens are needed for it. The heartbeat is started only here
// and answers wakes with another scripted run.
async function wakeScenario(w: World): Promise<void> {
  const { db, home, port } = w.inst;
  const memberId = addMember(w, "fake", "sleeper");
  const runDeps = { home, port, ...fakeLane([{ say: "woken" }]).deps };
  const stopBeat = startHeartbeat(db, { runDeps, home, tickMs: 1000 });
  try {
    const runId = await startOn(w, fakeLane(askThenSay("git branch -D gate5-two")), memberId);
    const approvalId = await pendingFor(w.inst, runId);
    killRun(db, runId, "gate_kill");
    await waitForRun(runId);
    const cookie = await signIn(w.inst);
    await stepUp(w.inst, cookie);
    const res = await w.inst.client.call("POST", `/api/approvals/${approvalId}`, {
      cookie,
      body: { decision: "approve" },
    });
    console.log(`   decision on the killed run's approval: HTTP ${res.status}`);
    await waitFor("the wake", () => approvalWakes(w, memberId, approvalId) > 0, 10_000).catch(
      () => 0,
    );
    await Bun.sleep(1500);
    const wakes = approvalWakes(w, memberId, approvalId);
    w.report.check(
      7,
      wakes === 1,
      `the killed run's member got exactly one approval_resolved wake (${wakes})`,
    );
  } finally {
    await stopBeat();
  }
}

async function requireCodex(inst: Instance): Promise<void> {
  const codex = (await listAgents(inst.db)).find((a) => a.id === "codex");
  if (!codex?.installed || codex.loggedIn !== true) {
    throw new Error(`codex is not installed or not logged in (${JSON.stringify(codex)})`);
  }
}

function codexUsage(inst: Instance): { input: number; output: number } {
  const row = inst.db
    .query<{ input: number; output: number }, []>(
      `SELECT COALESCE(sum(gen_ai_usage_input_tokens), 0) AS input,
              COALESCE(sum(gen_ai_usage_output_tokens), 0) AS output
         FROM events WHERE kind = 'usage' AND agent = 'codex'`,
    )
    .get();
  return { input: row?.input ?? 0, output: row?.output ?? 0 };
}

export interface PartAOptions {
  real: boolean;
  root?: string;
}

export interface PartAResult {
  passed: number;
  failures: string[];
  codexInputTokens: number;
  codexOutputTokens: number;
  claudeSpendUsd: number;
  home: string;
}

async function openWorld(root: string, mocks: Mocks, inst: Instance): Promise<World> {
  const admin = await enrollAdmin(inst);
  const org = listOrgsForUser(inst.db, admin.userId)[0];
  const member = org ? memberForUser(inst.db, org.id, admin.userId) : null;
  if (!org || !member) throw new Error("the admin has no personal org");
  const world = {
    inst,
    mocks,
    admin,
    orgId: org.id,
    adminMemberId: member.id,
    repo: scratchRepo(root),
    report: createReport(),
    webhookSecret: "",
  };
  return { ...world, webhookSecret: await configureTargets(world) };
}

export async function runPartA(opts: PartAOptions): Promise<PartAResult> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "harness-gate5-"));
  console.log(
    "Gate notifications use local test fixtures only; NODE_ENV=test permits loopback HTTP for push and webhook fixtures.",
  );
  const mocks = await startMocks();
  const inst = await bootInstance({ home: join(root, "home") });
  console.log(`home ${inst.home}, ${inst.origin}`);
  const problems: string[] = [];
  let passed = 0;
  try {
    if (opts.real) await requireCodex(inst);
    const w = await openWorld(root, mocks, inst);
    const lane: Lane = opts.real
      ? { agentId: "codex", prompt: CODEX_PROMPT, deps: {} }
      : fakeLane(askThenSay(ASK));
    await mainScenario(w, lane);
    await wakeScenario(w);
    await checkOauthAndMcp(w);
    await checkDesktopLink(w);
    passed = w.report.passed();
    problems.push(...w.report.failures());
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    await shutdownRuns(inst.db);
    await inst.stop();
    await mocks.stop();
  }
  const usage = codexUsage(inst);
  return {
    passed,
    failures: problems,
    codexInputTokens: usage.input,
    codexOutputTokens: usage.output,
    claudeSpendUsd: 0,
    home: inst.home,
  };
}
