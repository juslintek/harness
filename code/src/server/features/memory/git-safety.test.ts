import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gitOutput } from "../../git-env";
import { startMemory } from "./api";
import { drainCommits, ensureVaultRepo } from "./git-log";
import { createNote } from "./store";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

async function repoWithConfig(extra: string): Promise<string> {
  await ensureVaultRepo(env.dir);
  appendFileSync(join(vaultDir(env.dir), ".git", "config"), extra);
  return join(env.dir, "marker");
}

const hostile: Record<string, (marker: string) => string> = {
  fsmonitor: (m) => `[core]\n\tfsmonitor = touch ${m}\n`,
  worktree: () => "[core]\n\tworktree = /tmp\n",
  include: (m) => `[include]\n\tpath = ${m}\n`,
  filter: (m) => `[filter "x"]\n\tclean = touch ${m}\n`,
  "bare repo": () => "[core]\n\tbare = true\n",
};

for (const [name, section] of Object.entries(hostile)) {
  test(`startMemory refuses a vault config with ${name} and runs no command`, async () => {
    const marker = await repoWithConfig("");
    appendFileSync(join(vaultDir(env.dir), ".git", "config"), section(marker));
    expect(() => startMemory(env.db, { home: env.dir })).toThrow("memory vault");
    expect(existsSync(marker)).toBe(false);
  });
}

test("startMemory refuses an attributes file that names a filter or diff driver", async () => {
  await repoWithConfig("");
  const vault = vaultDir(env.dir);
  writeFileSync(join(vault, ".git", "info", "attributes"), "*.md filter=x\n");
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("driver");
  writeFileSync(join(vault, ".git", "info", "attributes"), "");
  mkdirSync(join(vault, "orgs"), { recursive: true });
  writeFileSync(join(vault, "orgs", ".gitattributes"), "*.md diff=x\n");
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("driver");
});

test("a repo made by the harness passes the check", async () => {
  await repoWithConfig("");
  const stop = startMemory(env.db, { home: env.dir });
  await stop();
});

test("a filter added after start never runs and the commit is skipped", async () => {
  await ensureVaultRepo(env.dir);
  const vault = vaultDir(env.dir);
  const marker = join(env.dir, "marker");
  appendFileSync(join(vault, ".git", "config"), `[filter "pwn"]\n\tclean = touch ${marker}\n`);
  mkdirSync(join(vault, "orgs", "A", "org"), { recursive: true });
  writeFileSync(join(vault, "orgs", "A", ".gitattributes"), "*.md filter=pwn\n");
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await createNote(env.db, env.dir, ctx(aliceA), orgNote, "hello");
    await drainCommits();
  } finally {
    console.error = original;
  }
  expect(existsSync(marker)).toBe(false);
  expect(await gitOutput(vault, ["rev-list", "--all", "--count"])).toBe("0\n");
  expect(errors.join("\n")).toContain("filter");
});

test("a merge driver or textconv in any .gitattributes is refused", async () => {
  await ensureVaultRepo(env.dir);
  const vault = vaultDir(env.dir);
  writeFileSync(join(vault, ".gitattributes"), "*.md merge=x\n");
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("driver");
  writeFileSync(join(vault, ".gitattributes"), "*.md diff\n*.md textconv=x\n");
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("driver");
});

async function commitCount(vault: string): Promise<string | null> {
  return gitOutput(vault, ["rev-list", "--all", "--count"]);
}

async function writeNoteQuietly(): Promise<string> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await createNote(env.db, env.dir, ctx(aliceA), orgNote, "hello");
    await drainCommits();
  } finally {
    console.error = original;
  }
  return errors.join("\n");
}

test("a symlinked refs/heads is refused and the other repo's branch does not move", async () => {
  await ensureVaultRepo(env.dir);
  const vault = vaultDir(env.dir);
  const other = join(env.dir, "other");
  mkdirSync(other);
  await gitOutput(other, ["init", "-q"]);
  const refs = join(other, ".git", "refs", "heads");
  const heads = join(vault, ".git", "refs", "heads");
  rmSync(heads, { recursive: true });
  symlinkSync(refs, heads);
  const log = await writeNoteQuietly();
  expect(readdirSync(refs)).toEqual([]);
  expect(await commitCount(vault)).toBe("0\n");
  expect(log).toContain(join(".git", "refs", "heads"));
  expect(log).not.toContain(env.dir);
});

test("an objects/info/alternates file is refused", async () => {
  await ensureVaultRepo(env.dir);
  const vault = vaultDir(env.dir);
  mkdirSync(join(vault, ".git", "objects", "info"), { recursive: true });
  writeFileSync(join(vault, ".git", "objects", "info", "alternates"), `${env.dir}\n`);
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("alternates");
  expect(await writeNoteQuietly()).toContain("alternates");
  expect(await commitCount(vault)).toBe("0\n");
});

test("a hard-linked .git/logs/HEAD is refused and the outside file stays unchanged", async () => {
  await ensureVaultRepo(env.dir);
  const vault = vaultDir(env.dir);
  const outside = join(env.dir, "outside");
  writeFileSync(outside, "keep\n");
  mkdirSync(join(vault, ".git", "logs"), { recursive: true });
  linkSync(outside, join(vault, ".git", "logs", "HEAD"));
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("hard-linked");
  expect(await writeNoteQuietly()).toContain("hard-linked");
  expect(readFileSync(outside, "utf8")).toBe("keep\n");
});
