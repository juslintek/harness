import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { gitEnv } from "../../git-env";

export class NotAGitRepo extends Error {
  constructor(path: string) {
    super(`not a git repository: ${path}`);
    this.name = "NotAGitRepo";
  }
}

export const RUN_ID: RegExp = /^[0-9a-f-]{36}$/;

interface GitResult {
  code: number;
  out: string;
  err: string;
}

async function git(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

export async function gitOk(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.err}`);
  return res.out;
}

export async function createWorktree(
  repo: string,
  runId: string,
  home: string,
): Promise<{ path: string; branch: string; gitCommonDir: string; base: string }> {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const probe = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo);
  if (probe.code !== 0) throw new NotAGitRepo(repo);
  // Agents report resolved paths (macOS /var is /private/var), so the guard root and the srt
  // allow list must be the resolved one too or every write inside the tree looks outside it.
  const parent = join(home, "worktrees");
  await mkdir(parent, { recursive: true });
  const path = join(await realpath(parent), runId);
  const branch = `harness/${runId}`;
  await gitOk(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  const base = await gitOk(["rev-parse", "HEAD"], repo);
  return { path, branch, gitCommonDir: probe.out, base };
}

// A failover attempt continues in the tree the earlier attempt left, so a vanished one is an error
// rather than a reason to start over from HEAD and lose the half-done work.
export async function reuseWorktree(
  path: string,
  branch: string,
): Promise<{ path: string; branch: string; gitCommonDir: string }> {
  if (!(await Bun.file(join(path, ".git")).exists())) throw new Error(`worktree is gone: ${path}`);
  const gitCommonDir = await gitOk(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    path,
  );
  return { path, branch, gitCommonDir };
}

export async function defaultBranch(repo: string): Promise<string> {
  const origin = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  if (origin.code === 0) return origin.out.replace(/^origin\//, "");
  return gitOk(["symbolic-ref", "--short", "HEAD"], repo);
}

// The branch stays so the manager can still review or merge the work after cleanup.
export async function removeWorktree(path: string): Promise<void> {
  const common = await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  await gitOk(["--git-dir", common, "worktree", "remove", "--force", path], common);
}
