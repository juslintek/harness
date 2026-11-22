import type { Database } from "bun:sqlite";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../agents/api";
import {
  claudeSettings,
  runTmpDir,
  type Scope,
  scrubEnv,
  wrapCommand,
  writeSrtSettings,
} from "../guard/api";
import { mintRunToken, type TokenScope } from "../mcp/api";
import type { Adapter } from "./adapter";
import { accountRunEnv, type RunAccount, runCodexHome } from "./launch-accounts";
import { memoryFileEnv } from "./memory-file";
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
  // Notes for an engine without MCP; written to the run dir and named by HARNESS_MEMORY_FILE.
  memoryIndex?: string | undefined;
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
  // Runs after the lane returns: stores what the run changed in its account (a refreshed token).
  finish?: () => Promise<void>;
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

interface RunEnvInput {
  runDir: string;
  runId: string;
  token: string;
  base: string;
  codexHome: string | null;
  account: RunAccount | null;
  spec: AgentSpec;
  treePath: string;
  branch: string;
  scratch: { path: string } | null;
}

function runEnv(deps: RunDeps, i: RunEnvInput): Record<string, string> {
  const tmp = runTmpDir(i.runDir);
  return scrubEnv(process.env, {
    ...deps.agentEnv?.(i.runDir),
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    ...accountRunEnv(i.spec, i.account),
    // The guard treats git log/diff/show as read-only, which only holds while no pager runs; the
    // env wins over core.pager and pager.<cmd> in any config the run can reach.
    GIT_PAGER: "cat",
    PAGER: "cat",
    ...(i.codexHome === null ? {} : { CODEX_HOME: i.codexHome }),
    HARNESS_SCOPE_ROOT: i.treePath,
    HARNESS_DEFAULT_BRANCH: i.branch,
    HARNESS_HOOK_URL: `${i.base}/api/guard/hook`,
    HARNESS_RUN_TOKEN: i.token,
    HARNESS_RUN_ID: i.runId,
    ...(i.scratch === null ? {} : { HARNESS_SCRATCH: i.scratch.path }),
  });
}

interface SettingsInput {
  spec: AgentSpec;
  home: string;
  runDir: string;
  tree: { path: string; branch: string; gitCommonDir: string };
  codexHome: string | null;
  account: RunAccount | null;
  member: RunMember | RunCandidate | undefined;
  scratch: { path: string; gitDir: string } | null;
}

async function writeRunSettings(i: SettingsInput): Promise<string> {
  return writeSrtSettings({
    runDir: i.runDir,
    worktree: i.tree.path,
    gitCommonDir: i.tree.gitCommonDir,
    gitWorktreeDir: await worktreeAdminDir(i.tree.path),
    branch: i.tree.branch,
    agentId: i.spec.id,
    harnessHome: i.home,
    agentStateWrite: i.spec.stateWrite,
    agentEgress: i.spec.egress,
    preset: "dev",
    weakerNetworkIsolation: i.spec.weakerNetworkIsolation,
    codexHome: i.codexHome,
    account: i.account,
    readOnlyWorktree:
      i.member !== undefined && ("candidateId" in i.member || i.member.readOnly === true),
    ...(i.scratch === null ? {} : { scratch: i.scratch }),
  });
}

const treeFor = (
  repo: string,
  runId: string,
  home: string,
  reuse: { worktree: string; branch: string } | undefined,
): ReturnType<typeof reuseWorktree> =>
  reuse ? reuseWorktree(reuse.worktree, reuse.branch) : createWorktree(repo, runId, home);

export async function createLaunch(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  runId: string,
  repo: string,
  member?: RunMember | RunCandidate,
  reuse?: { worktree: string; branch: string },
  account: RunAccount | null = null,
): Promise<Launch> {
  // srt's sandbox profile matches resolved paths only, so a home behind a symlink (macOS /var)
  // would leave the run's own tmp dir read-only and break heredocs.
  await mkdir(deps.home, { recursive: true });
  const home = await realpath(deps.home);
  const tree = await treeFor(repo, runId, home, reuse);
  const branch = await defaultBranch(repo);
  const scratch = await scratchFor(repo, home, runId, member);
  const runDir = join(home, "runs", runId);
  const token = tokenFor(db, runId, member);
  const codex = await runCodexHome(spec, runDir, account);
  const codexHome = codex?.home ?? null;
  try {
    const settingsPath = await writeRunSettings({
      spec,
      home,
      runDir,
      tree,
      codexHome,
      account,
      member,
      scratch,
    });
    const base = `http://127.0.0.1:${deps.port}`;
    const index = member === undefined || "candidateId" in member ? undefined : member.memoryIndex;
    const env = runEnv(deps, {
      runDir,
      runId,
      token,
      base,
      codexHome,
      account,
      spec,
      treePath: tree.path,
      branch,
      scratch,
    });
    Object.assign(env, await memoryFileEnv(runDir, index));
    return {
      worktree: tree.path,
      branch: tree.branch,
      argv: wrapCommand(settingsPath, [spec.bin, ...spec.args]),
      env,
      mcp: { url: `${base}/mcp`, token },
      claudeSettings: claudeSettings(process.execPath, HOOK_SCRIPT),
      scope: { root: tree.path, home: homedir(), harnessHome: home, defaultBranch: branch },
      ...(codex?.finish ? { finish: codex.finish } : {}),
    };
  } catch (err) {
    // The run never starts, so nothing reaches the account; this only drops the token copy.
    await codex?.finish?.();
    throw err;
  }
}

// A throwaway sandbox for asking an agent which models it offers: same srt wrapping and scrubbed
// env as a run, but no worktree, no run token and no MCP.
export async function createProbeLaunch(
  deps: RunDeps,
  spec: AgentSpec,
  dir: string,
  account: RunAccount | null = null,
): Promise<{
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  finish: (() => Promise<void>) | null;
}> {
  await mkdir(deps.home, { recursive: true });
  const home = await realpath(deps.home);
  const cwd = join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  const codex = await runCodexHome(spec, dir, account);
  const codexHome = codex?.home ?? null;
  const settingsPath = await writeSrtSettings({
    runDir: dir,
    worktree: cwd,
    gitCommonDir: null,
    agentId: spec.id,
    harnessHome: home,
    agentStateWrite: spec.stateWrite,
    agentEgress: spec.egress,
    preset: "dev",
    weakerNetworkIsolation: spec.weakerNetworkIsolation,
    codexHome,
    account,
  });
  const tmp = runTmpDir(dir);
  const env = scrubEnv(process.env, {
    ...deps.agentEnv?.(dir),
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    ...accountRunEnv(spec, account),
    ...(codexHome === null ? {} : { CODEX_HOME: codexHome }),
  });
  return {
    argv: wrapCommand(settingsPath, [spec.bin, ...spec.args]),
    env,
    cwd,
    finish: codex?.finish ?? null,
  };
}
