import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMemory } from "./api";
import { ensureVaultRepo } from "./git-log";
import { type Env, setup, teardown } from "./store-test-kit";
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
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("filter or diff");
  writeFileSync(join(vault, ".git", "info", "attributes"), "");
  mkdirSync(join(vault, "orgs"), { recursive: true });
  writeFileSync(join(vault, "orgs", ".gitattributes"), "*.md diff=x\n");
  expect(() => startMemory(env.db, { home: env.dir })).toThrow("filter or diff");
});

test("a repo made by the harness passes the check", async () => {
  await repoWithConfig("");
  const stop = startMemory(env.db, { home: env.dir });
  await stop();
});
