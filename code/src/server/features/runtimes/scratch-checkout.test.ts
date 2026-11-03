import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScratchCheckout,
  dropScratchCheckout,
  sweepScratchCheckouts,
} from "./scratch-checkout";

const root = realpathSync(mkdtempSync(join(tmpdir(), "scratch-test-")));
afterAll(() => rm(root, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
}

async function makeRepo(): Promise<string> {
  const repo = join(root, `repo-${Bun.randomUUIDv7()}`);
  mkdirSync(repo);
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
    "i",
  );
  return repo;
}

test("a run id that is not a uuid never reaches the path", async () => {
  const repo = await makeRepo();
  await expect(createScratchCheckout(repo, "../../etc", join(root, "home"))).rejects.toThrow(
    "invalid run id",
  );
  expect(existsSync(join(root, "etc"))).toBe(false);
});

test("sweep removes checkouts of runs that are not live and keeps live ones and foreign names", async () => {
  const repo = await makeRepo();
  const home = join(root, "home");
  const live = await createScratchCheckout(repo, Bun.randomUUIDv7(), home);
  // Left behind by a crash: git knows it, the in-memory map does not.
  const stale = join(home, "scratch-checkouts", Bun.randomUUIDv7());
  await git(repo, "worktree", "add", "--detach", stale, "HEAD");
  const foreign = join(home, "scratch-checkouts", "not-a-run");
  mkdirSync(foreign);
  await sweepScratchCheckouts(home);
  expect(existsSync(stale)).toBe(false);
  expect(await git(repo, "worktree", "list")).not.toContain(stale);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  await dropScratchCheckout(live.slice(live.lastIndexOf("/") + 1));
});
