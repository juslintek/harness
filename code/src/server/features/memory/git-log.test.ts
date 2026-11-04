import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOutput } from "../../git-env";
import {
  assertVaultGit,
  drainCommits,
  ensureVaultRepo,
  queueCommit,
  queueUncommitted,
} from "./git-log";
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
  await Bun.write(join(vaultDir(env.dir), orgNote.disk), "# one");
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

test("only note files are committed: a dropped credentials file never reaches history", async () => {
  const vault = vaultDir(env.dir);
  await ensureVaultRepo(env.dir);
  await Bun.write(join(vault, "credentials.txt"), "hunter2");
  await Bun.write(join(vault, "orgs", "o1", "org", "keys.env"), "TOKEN=abc");
  await Bun.write(join(vault, orgNote.disk), "# ok");
  queueCommit(env.dir, "files");
  await drainCommits();
  const stat = (await gitOutput(vault, ["log", "--all", "--stat"])) ?? "";
  expect(stat).toContain(orgNote.disk);
  expect(stat).not.toContain("credentials.txt");
  expect(stat).not.toContain("keys.env");
});

test("a file already staged in an existing repo is not swept into the next note commit", async () => {
  const vault = vaultDir(env.dir);
  await ensureVaultRepo(env.dir);
  await Bun.write(join(vault, "credentials.json"), '{"token":"abc"}');
  await gitOutput(vault, ["add", "-f", "credentials.json"]);
  await Bun.write(join(vault, orgNote.disk), "# ok");
  queueCommit(env.dir, "files");
  await drainCommits();
  const files = (await gitOutput(vault, ["ls-tree", "-r", "--name-only", "HEAD"])) ?? "";
  expect(files).toContain(orgNote.disk);
  expect(files).not.toContain("credentials.json");
});

test("an existing vault gets the ignore rules and keeps its old entries", async () => {
  const vault = vaultDir(env.dir);
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, ".gitignore"), "*.tmp\ncustom\n");
  await ensureVaultRepo(env.dir);
  expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("custom\n*.tmp\n*\n!*/\n!*.md\n");
});

test("a user rule after the harness rules is moved above them so notes are still committed", async () => {
  const vault = vaultDir(env.dir);
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, ".gitignore"), "*.tmp\n*\n!*/\n!*.md\n*.md\n");
  await ensureVaultRepo(env.dir);
  expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("*.md\n*.tmp\n*\n!*/\n!*.md\n");
  await Bun.write(join(vault, orgNote.disk), "# ok");
  queueCommit(env.dir, "files");
  await drainCommits();
  expect((await gitOutput(vault, ["ls-tree", "-r", "--name-only", "HEAD"])) ?? "").toContain(
    orgNote.disk,
  );
});

test("a symlinked .gitignore is replaced and its outside target is left untouched", async () => {
  const vault = vaultDir(env.dir);
  mkdirSync(vault, { recursive: true });
  const target = join(env.dir, "outside-target");
  writeFileSync(target, "keep me\n");
  symlinkSync(target, join(vault, ".gitignore"));
  await ensureVaultRepo(env.dir);
  expect(readFileSync(target, "utf8")).toBe("keep me\n");
  expect(lstatSync(join(vault, ".gitignore")).isFile()).toBe(true);
  expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("*.tmp\n*\n!*/\n!*.md\n");
});

test("a hard-linked .gitignore is replaced and the file outside the vault is left untouched", async () => {
  const vault = vaultDir(env.dir);
  mkdirSync(vault, { recursive: true });
  const target = join(env.dir, "outside-target");
  writeFileSync(target, "keep me\n");
  linkSync(target, join(vault, ".gitignore"));
  await ensureVaultRepo(env.dir);
  expect(readFileSync(target, "utf8")).toBe("keep me\n");
  expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("keep me\n*.tmp\n*\n!*/\n!*.md\n");
});

test("a .git symlink or gitdir file refuses the vault and is left in place", async () => {
  const vault = vaultDir(env.dir);
  mkdirSync(vault, { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "harness-outside-git-"));
  try {
    symlinkSync(outside, join(vault, ".git"));
    await expect(ensureVaultRepo(env.dir)).rejects.toThrow("symlink");
    expect(() => assertVaultGit(env.dir)).toThrow("not a directory");
    expect(lstatSync(join(vault, ".git")).isSymbolicLink()).toBe(true);
    rmSync(join(vault, ".git"));
    writeFileSync(join(vault, ".git"), `gitdir: ${outside}\n`);
    expect(() => assertVaultGit(env.dir)).toThrow("file");
    expect(readFileSync(join(vault, ".git"), "utf8")).toContain("gitdir:");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink at a valid note path is never committed", async () => {
  const vault = vaultDir(env.dir);
  await ensureVaultRepo(env.dir);
  const target = join(env.dir, "outside.txt");
  writeFileSync(target, "secret");
  mkdirSync(join(vault, "orgs", "o1", "org"), { recursive: true });
  symlinkSync(target, join(vault, "orgs", "o1", "org", "link.md"));
  await Bun.write(join(vault, orgNote.disk), "# ok");
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    queueCommit(env.dir, "files");
    await drainCommits();
  } finally {
    console.error = original;
  }
  const tree = (await gitOutput(vault, ["ls-tree", "-r", "HEAD"])) ?? "";
  expect(tree).toContain(orgNote.disk);
  expect(tree).not.toContain("link.md");
  expect(errors.join("\n")).toContain("link.md");
});

test("a commit that fails once is retried and lands without another write", async () => {
  await ensureVaultRepo(env.dir);
  const lock = join(vaultDir(env.dir), ".git", "index.lock");
  writeFileSync(lock, "");
  await Bun.write(join(vaultDir(env.dir), orgNote.disk), "# one");
  queueCommit(env.dir, "first");
  await Bun.sleep(800);
  expect(await log("%s")).toEqual([]);
  rmSync(lock);
  for (let i = 0; i < 30 && (await log("%s")).length === 0; i++) await Bun.sleep(100);
  expect(await log("%s")).toEqual(["first"]);
  await drainCommits();
});

test("startup queues a commit for valid notes left uncommitted", async () => {
  await ensureVaultRepo(env.dir);
  await Bun.write(join(vaultDir(env.dir), orgNote.disk), "# left behind");
  await queueUncommitted(env.dir, env.db);
  await drainCommits();
  expect(await log("%s")).toEqual(["commit notes left uncommitted"]);
});

test("a failed reset abandons the attempt, so a hand-staged file is never committed", async () => {
  const vault = vaultDir(env.dir);
  await ensureVaultRepo(env.dir);
  await Bun.write(join(vault, "credentials.json"), '{"token":"abc"}');
  await gitOutput(vault, ["add", "-f", "credentials.json"]);
  await Bun.write(join(vault, orgNote.disk), "# ok");
  const real = Bun.spawn;
  // Only reset is broken; add, diff and commit would all succeed.
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) =>
    real(
      cmd.map((a) => (a === "reset" ? "reset-broken" : a)),
      opts,
    )) as typeof Bun.spawn);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  queueCommit(env.dir, "files");
  await drainCommits();
  spy.mockRestore();
  errors.mockRestore();
  expect(await log("%s")).toEqual([]);
});
