import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOutput } from "../../git-env";
import { drainCommits, ensureVaultRepo, queueCommit } from "./git-log";
import { createNote, updateNote } from "./store";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

async function log(format: string): Promise<string[]> {
  const out = await gitOutput(vaultDir(env.dir), ["log", `--format=${format}`]);
  return (out ?? "").split("\n").filter((l) => l !== "");
}

test("three writes within 100 ms make one commit by the harness identity", async () => {
  const c = ctx(aliceA);
  const n = (await createNote(env.db, env.dir, c, orgNote, "one")).note;
  const m = updateNote(env.db, env.dir, c, n.id, n.hash, "two").note;
  updateNote(env.db, env.dir, c, m.id, m.hash, "three");
  await drainCommits();
  expect(await log("%an <%ae>")).toEqual(["harness <harness@localhost>"]);
  const files = await gitOutput(vaultDir(env.dir), ["ls-files"]);
  expect(files).toContain(orgNote.disk);
});

test("drain flushes the pending debounce and ignores nothing-to-commit", async () => {
  await ensureVaultRepo(env.dir);
  queueCommit(env.dir, "first");
  await drainCommits();
  queueCommit(env.dir, "nothing changed");
  const started = Date.now();
  await drainCommits();
  expect(Date.now() - started).toBeLessThan(400);
  expect(await log("%s")).toEqual(["first"]);
});

test("tmp files are never committed", async () => {
  await Bun.write(`${vaultDir(env.dir)}/x.md.abc.tmp`, "partial");
  await Bun.write(`${vaultDir(env.dir)}/y.md`, "ok");
  await ensureVaultRepo(env.dir);
  queueCommit(env.dir, "files");
  await drainCommits();
  expect(await gitOutput(vaultDir(env.dir), ["ls-files"])).not.toContain(".tmp");
});

test("a global core.hooksPath hook does not run on vault commits", async () => {
  const hooks = mkdtempSync(join(tmpdir(), "harness-hooks-"));
  const marker = join(hooks, "ran");
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(hook, 0o755);
  const cfg = join(hooks, "gitconfig");
  writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n`);
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    const c = ctx(aliceA);
    await createNote(env.db, env.dir, c, orgNote, "one");
    await drainCommits();
    expect(await log("%s")).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
    rmSync(hooks, { recursive: true, force: true });
  }
});
