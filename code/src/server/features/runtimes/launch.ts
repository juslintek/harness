import type { Database } from "bun:sqlite";
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
import { mintRunToken } from "../mcp/api";
import { prepareCodexHome } from "./codex-home";
import { createWorktree, defaultBranch } from "./worktree";

export interface RunDeps {
  home: string;
  port: number;
  resolveSpec?: (id: string) => AgentSpec | null;
  idleTimeoutMs?: number;
  approvalTimeoutMs?: number;
  breaker?: { maxEventsPerMinute: number; maxTokens: number };
  // Test hook: the real run env is scrubbed, so a fake agent gets its script through here.
  agentEnv?: (runDir: string) => Record<string, string>;
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

export async function createLaunch(
  db: Database,
  deps: RunDeps,
  spec: AgentSpec,
  runId: string,
  repo: string,
): Promise<Launch> {
  const tree = await createWorktree(repo, runId, deps.home);
  const branch = await defaultBranch(repo);
  const runDir = join(deps.home, "runs", runId);
  const token = mintRunToken(db, runId, ["report", "guard_hook"]);
  const codexHome = spec.id === "codex" ? await prepareCodexHome(runDir, codexRules()) : null;
  const settingsPath = await writeSrtSettings({
    runDir,
    worktree: tree.path,
    gitCommonDir: tree.gitCommonDir,
    harnessHome: deps.home,
    agentStateWrite: spec.stateWrite,
    agentEgress: spec.egress,
    preset: "dev",
    weakerNetworkIsolation: spec.weakerNetworkIsolation,
    codexHome,
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
  });
  return {
    worktree: tree.path,
    branch: tree.branch,
    argv: wrapCommand(settingsPath, [spec.bin, ...spec.args]),
    env,
    mcp: { url: `${base}/mcp`, token },
    claudeSettings: claudeSettings(`${process.execPath} ${HOOK_SCRIPT}`),
    scope: { root: tree.path, home: homedir(), defaultBranch: branch },
  };
}
