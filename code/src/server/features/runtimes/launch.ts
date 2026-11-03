import type { Database } from "bun:sqlite";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../agents/api";
import {
  claudeSettings,
  codexRules,
  runTmpDir,
  type Scope,
  scrubEnv,
  wrapCommand,
  writeSrtSettings,
} from "../guard/api";
import { mintRunToken, type TokenScope } from "../mcp/api";
import type { Adapter } from "./adapter";
import { prepareCodexHome } from "./codex-home";
import { createScratchCheckout } from "./scratch-checkout";
import { createWorktree, defaultBranch, reuseWorktree } from "./worktree";

export interface RunDeps {
  home: string;
  port: number;
  resolveSpec?: (id: string) => AgentSpec | null;
  idleTimeoutMs?: number;
  approvalTimeoutMs?: number;
  breaker?: { maxEventsPerMinute: number; maxTokens: number };
  // Test hook: the real run env is scrubbed, so a fake agent gets its script through here.
  agentEnv?: (runDir: string) => Record<string, string>;
  // Test hook: replaces the lane adapter so a test controls when and how the lane returns.
  lane?: Adapter;
}

export interface RunMember {
  memberId: string;
  orgId: string;
  scopes: TokenScope[];
  // A manager reviews and delegates; its worktree is read-only in srt.
  readOnly?: boolean | undefined;
  // The project whose repo the run works in; its org decides the run's approvals.
  projectId?: string | undefined;
}

// An interview run has no member: its token carries the candidate id and only the interview scope.
export interface RunCandidate {
  candidateId: string;
  orgId: string;
  // The member whose budgets the run counts against; null when a person without a member asked.
  chargedTo: string | null;
}

const CANDIDATE_SCOPES: TokenScope[] = ["report", "guard_hook", "interview"];

function tokenFor(db: Database, runId: string, who: RunMember | RunCandidate | undefined): string {
  if (!who) return mintRunToken(db, runId, ["report", "guard_hook"]);
  if ("candidateId" in who) return mintRunToken(db, runId, CANDIDATE_SCOPES, who);
  return mintRunToken(db, runId, who.scopes, who);
}

export interface Launch {
  worktree: string | null;
  branch: string | null;
  argv: string[];
  env: Record<string, string>;
  mcp: { url: string; token: string } | null;
  claudeSettings: unknown;
  scope: Scope;
}

const HOOK_SCRIPT = join(import.meta.dir, "../../../../scripts/guard-hook.ts");

// The api lane runs in-process: nothing to sandbox and no worktree to give it.
export function inProcessLaunch(repo: string): Launch {
  return {
    worktree: null,
    branch: null,
    argv: [],
    env: {},
    mcp: null,
    claudeSettings: {},
    scope: { root: repo, home: homedir(), defaultBranch: "main" },
  };
}

// A linked worktree's `.git` file reads `gitdir: <common>/worktrees/<name>`.
async function worktreeAdminDir(worktree: string): Promise<string> {
  const pointer = (await Bun.file(join(worktree, ".git")).text()).trim();
  if (!pointer.startsWith("gitdir: ")) throw new Error(`unexpected .git file in ${worktree}`);
  return pointer.slice("gitdir: ".length);
}

// Only a manager run gets one; an interview run is read-only too but runs nothing.
async function scratchFor(
  repo: string,
  home: string,
  runId: string,
  member: RunMember | RunCandidate | undefined,
): Promise<{ path: string; gitDir: string } | null> {
  if (member === undefined || "candidateId" in member || member.readOnly !== true) return null;
  const path = await createScratchCheckout(repo, runId, home);
  return { path, gitDir: await worktreeAdminDir(path) };
}

export async function createLaunch(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  runId: string,
  repo: string,
  member?: RunMember | RunCandidate,
  reuse?: { worktree: string; branch: string },
): Promise<Launch> {
  // srt's sandbox profile matches resolved paths only, so a home behind a symlink (macOS /var)
  // would leave the run's own tmp dir read-only and break heredocs.
  await mkdir(deps.home, { recursive: true });
  const home = await realpath(deps.home);
  const tree = reuse
    ? await reuseWorktree(reuse.worktree, reuse.branch)
    : await createWorktree(repo, runId, home);
  const branch = await defaultBranch(repo);
  const scratch = await scratchFor(repo, home, runId, member);
  const runDir = join(home, "runs", runId);
  const token = tokenFor(db, runId, member);
  const codexHome = spec.id === "codex" ? await prepareCodexHome(runDir, codexRules()) : null;
  const settingsPath = await writeSrtSettings({
    runDir,
    worktree: tree.path,
    gitCommonDir: tree.gitCommonDir,
    gitWorktreeDir: await worktreeAdminDir(tree.path),
    branch: tree.branch,
    agentId: spec.id,
    harnessHome: home,
    agentStateWrite: spec.stateWrite,
    agentEgress: spec.egress,
    preset: "dev",
    weakerNetworkIsolation: spec.weakerNetworkIsolation,
    codexHome,
    readOnlyWorktree: member !== undefined && ("candidateId" in member || member.readOnly === true),
    ...(scratch === null ? {} : { scratch }),
  });
  const tmp = runTmpDir(runDir);
  const base = `http://127.0.0.1:${deps.port}`;
  const env = scrubEnv(process.env, {
    ...deps.agentEnv?.(runDir),
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    ...(codexHome === null ? {} : { CODEX_HOME: codexHome }),
    HARNESS_SCOPE_ROOT: tree.path,
    HARNESS_DEFAULT_BRANCH: branch,
    HARNESS_HOOK_URL: `${base}/api/guard/hook`,
    HARNESS_RUN_TOKEN: token,
    HARNESS_RUN_ID: runId,
    ...(scratch === null ? {} : { HARNESS_SCRATCH: scratch.path }),
  });
  return {
    worktree: tree.path,
    branch: tree.branch,
    argv: wrapCommand(settingsPath, [spec.bin, ...spec.args]),
    env,
    mcp: { url: `${base}/mcp`, token },
    claudeSettings: claudeSettings(process.execPath, HOOK_SCRIPT),
    scope: { root: tree.path, home: homedir(), harnessHome: home, defaultBranch: branch },
  };
}

// A throwaway sandbox for asking an agent which models it offers: same srt wrapping and scrubbed
// env as a run, but no worktree, no run token and no MCP.
export async function createProbeLaunch(
  deps: RunDeps,
  spec: AgentSpec,
  dir: string,
): Promise<{ argv: string[]; env: Record<string, string>; cwd: string }> {
  const cwd = join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  const codexHome = spec.id === "codex" ? await prepareCodexHome(dir, codexRules()) : null;
  const settingsPath = await writeSrtSettings({
    runDir: dir,
    worktree: cwd,
    gitCommonDir: null,
    agentId: spec.id,
    harnessHome: deps.home,
    agentStateWrite: spec.stateWrite,
    agentEgress: spec.egress,
    preset: "dev",
    weakerNetworkIsolation: spec.weakerNetworkIsolation,
    codexHome,
  });
  const tmp = runTmpDir(dir);
  const env = scrubEnv(process.env, {
    ...deps.agentEnv?.(dir),
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    ...(codexHome === null ? {} : { CODEX_HOME: codexHome }),
  });
  return { argv: wrapCommand(settingsPath, [spec.bin, ...spec.args]), env, cwd };
}
