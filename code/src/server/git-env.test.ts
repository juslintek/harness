import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "./features/runtimes/worktree";
import { gitEnv } from "./git-env";

const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-test-")));
afterAll(() => rm(root, { recursive: true, force: true }));

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env,
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
}

test("gitEnv drops repo-locating variables and keeps the rest", () => {
  const env = gitEnv({ GIT_DIR: "/x", GIT_INDEX_FILE: "/y", GIT_PREFIX: "a/", PATH: "/bin" });
  expect(env).toEqual({ PATH: "/bin" });
});

test("createWorktree ignores an inherited GIT_DIR pointing at another repo", async () => {
  const clean = gitEnv();
  const victim = join(root, "victim");
  const target = join(root, "target");
  for (const dir of [victim, target]) {
    Bun.spawnSync(["mkdir", dir]);
    git(dir, clean, "init", "-q", "-b", "main");
    git(dir, clean, "commit", "-q", "--allow-empty", "-m", "init");
  }
  const before = readFileSync(join(victim, ".git", "config"), "utf8");
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(victim, ".git");
  try {
    const wt = await createWorktree(target, Bun.randomUUIDv7(), join(root, "home"));
    expect(git(wt.path, clean, "rev-parse", "--show-toplevel")).toBe(realpathSync(wt.path));
    expect(wt.gitCommonDir).toBe(join(target, ".git"));
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
  expect(readFileSync(join(victim, ".git", "config"), "utf8")).toBe(before);
  expect(git(victim, clean, "worktree", "list")).not.toContain("harness/");
  expect(git(victim, clean, "branch", "--list", "harness/*")).toBe("");
  expect(git(target, clean, "branch", "--list", "harness/*")).toContain("harness/");
});
