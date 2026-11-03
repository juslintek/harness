import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTmpDir, type SandboxInput, scrubEnv, wrapCommand, writeSrtSettings } from "./sandbox";

export const baseInput: SandboxInput = {
  runDir: "/runs/r1",
  worktree: "/wt/r1",
  gitCommonDir: "/repo/.git",
  gitWorktreeDir: "/repo/.git/worktrees/r1",
  branch: "harness/r1",
  agentId: "claude",
  harnessHome: "/hh",
  agentStateWrite: ["~/.claude", "/private/tmp/claude-<uid>", "/private/tmp/claude-*-cwd"],
  agentEgress: ["api.anthropic.com", "github.com"],
  preset: "dev",
  weakerNetworkIsolation: true,
  codexHome: null,
};

export interface Live {
  dir: string;
  repo: string;
  gitDir: string;
  adminDir: string;
  harnessHome: string;
  runDir: string;
  worktree: string;
  run: (cmd: string) => Promise<number>;
  // Stderr of the latest run.
  stderr: () => string;
}

function runner(
  settings: string,
  cwd: string,
  env: Record<string, string>,
): Pick<Live, "run" | "stderr"> {
  let lastStderr = "";
  const run = async (cmd: string): Promise<number> => {
    const proc = Bun.spawn(wrapCommand(settings, ["sh", "-c", cmd]), {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    lastStderr = err;
    return code;
  };
  return { run, stderr: () => lastStderr };
}

async function seed(repo: string, worktree: string, harnessHome: string): Promise<void> {
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.quiet();
  await Bun.$`git -C ${repo} worktree add -q -b harness/x ${worktree}`.quiet();
  for (const f of [
    "harness.db",
    "harness.db-wal",
    "secret",
    "secrets.json",
    "runs/other/srt.json",
  ]) {
    await Bun.write(join(harnessHome, f), "s");
  }
}

export async function liveFixture(readOnlyWorktree = false): Promise<Live> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "srt-live-")));
  const repo = join(dir, "repo");
  const harnessHome = join(dir, "hh");
  const runDir = join(harnessHome, "runs", "mine");
  const worktree = join(harnessHome, "worktrees", "mine");
  for (const d of [
    repo,
    join(harnessHome, "worktrees"),
    join(harnessHome, "runs", "other"),
    runDir,
  ])
    await mkdir(d, { recursive: true });
  await seed(repo, worktree, harnessHome);
  const gitDir = join(repo, ".git");
  const adminDir = (await Bun.file(join(worktree, ".git")).text()).trim().slice("gitdir: ".length);
  const settings = await writeSrtSettings({
    ...baseInput,
    runDir,
    worktree,
    gitCommonDir: gitDir,
    gitWorktreeDir: adminDir,
    branch: "harness/x",
    harnessHome,
    agentStateWrite: [],
    agentEgress: [],
    preset: "offline",
    weakerNetworkIsolation: false,
    readOnlyWorktree,
  });
  const env = scrubEnv(process.env, {
    TMPDIR: runTmpDir(runDir),
    CLAUDE_CODE_TMPDIR: runTmpDir(runDir),
  });
  const { run, stderr } = runner(settings, worktree, env);
  return {
    dir,
    repo,
    gitDir,
    adminDir,
    harnessHome,
    runDir,
    worktree,
    run,
    stderr,
  };
}
