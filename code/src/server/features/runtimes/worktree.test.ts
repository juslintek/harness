import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, defaultBranch, NotAGitRepo, removeWorktree } from "./worktree";

const ID = Bun.randomUUIDv7();
const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
afterAll(() => rm(root, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(root, name);
  await Bun.$`mkdir ${repo}`.quiet();
  await git(repo, "init", "-b", "main");
  await git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
  return repo;
}

test("createWorktree adds a branch and a directory; removeWorktree keeps the branch", async () => {
  const repo = await makeRepo("repo");
  const home = join(root, "home");
  const wt = await createWorktree(repo, ID, home);
  expect(wt.path).toBe(join(home, "worktrees", ID));
  expect(wt.branch).toBe(`harness/${ID}`);
  expect(wt.gitCommonDir).toBe(join(repo, ".git"));
  expect(wt.base).toBe(await git(repo, "rev-parse", "HEAD"));
  expect(existsSync(wt.path)).toBe(true);
  await removeWorktree(wt.path);
  expect(existsSync(wt.path)).toBe(false);
  expect(await git(repo, "branch", "--list", `harness/${ID}`)).toContain(`harness/${ID}`);
});

test("createWorktree throws NotAGitRepo outside a repo", async () => {
  const plain = join(root, "plain");
  await Bun.$`mkdir ${plain}`.quiet();
  await expect(createWorktree(plain, ID, join(root, "h2"))).rejects.toBeInstanceOf(NotAGitRepo);
});

test("createWorktree rejects run ids that are not uuid text", async () => {
  const repo = await makeRepo("repo4");
  for (const bad of ["../x", "a/b", "-x", ""]) {
    await expect(createWorktree(repo, bad, join(root, "h4"))).rejects.toThrow(/invalid run id/);
  }
  expect(existsSync(join(root, "h4"))).toBe(false);
});

test("defaultBranch falls back to the current branch without origin/HEAD", async () => {
  const repo = await makeRepo("repo2");
  expect(await defaultBranch(repo)).toBe("main");
});

test("defaultBranch prefers origin/HEAD", async () => {
  const repo = await makeRepo("repo3");
  await git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await defaultBranch(repo)).toBe("trunk");
});
