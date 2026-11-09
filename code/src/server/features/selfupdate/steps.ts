import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { classify } from "./classify";
import { changedFiles } from "./diff";
import { type CommandResult, runCommand } from "./proc";

export interface StepDeps {
  install: string[];
  check: string[];
  build: (outDir: string) => string[];
  // Defaults to the version in the worktree's package.json, which is what the build bakes in.
  expectedVersion?: string;
}

export const DEFAULT_STEPS: StepDeps = {
  install: ["bun", "install", "--frozen-lockfile"],
  check: ["bun", "run", "check"],
  build: (outDir) => ["bun", "scripts/build.ts", "--target", "host", "--out", outDir],
};

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runCommand(["git", ...args], cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.out}`);
  return res.out;
}

export async function resolveCommit(repo: string, branch: string): Promise<string> {
  return git(["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`], repo);
}

export async function addWorktree(repo: string, path: string, sha: string): Promise<void> {
  await git(["worktree", "add", "--detach", path, sha], repo);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(["worktree", "remove", "--force", path], repo).catch(() =>
    rmSync(path, { recursive: true, force: true }),
  );
}

export async function classifyChange(repo: string, sha: string): Promise<string[]> {
  const readNew = async (path: string): Promise<string | null> => {
    const res = await runCommand(["git", "show", `${sha}:${path}`], repo);
    return res.code === 0 ? res.out : null;
  };
  return (await classify(await changedFiles(repo, sha), readNew)).flagged;
}

export async function headSha(tree: string): Promise<string> {
  return git(["rev-parse", "HEAD"], tree);
}

async function runStep(argv: string[], cwd: string, label: string): Promise<CommandResult> {
  const res = await runCommand(argv, cwd);
  if (res.code !== 0)
    throw new Error(`${label} failed (exit ${res.code}): ${res.out.slice(-2000)}`);
  return res;
}

export async function runCheck(deps: StepDeps, codeDir: string): Promise<string> {
  await runStep(deps.install, codeDir, "install");
  return (await runStep(deps.check, codeDir, "check")).out;
}

// The last stdout line is the binary path (scripts/build.ts prints it); stderr is left out so a
// warning cannot be mistaken for it. The binary is copied under the home so removing the worktree
// does not remove the build.
export async function runBuild(
  deps: StepDeps,
  codeDir: string,
  outDir: string,
  stored: string,
): Promise<string> {
  const { stdout } = await runStep(deps.build(outDir), codeDir, "build");
  const built = stdout.split("\n").at(-1)?.trim();
  if (!built) throw new Error("build printed no binary path");
  mkdirSync(join(stored, ".."), { recursive: true });
  copyFileSync(built, stored);
  chmodSync(stored, 0o755);
  return stored;
}

export function expectedVersion(deps: StepDeps, codeDir: string): string {
  if (deps.expectedVersion) return deps.expectedVersion;
  return (JSON.parse(readFileSync(join(codeDir, "package.json"), "utf8")) as { version: string })
    .version;
}
