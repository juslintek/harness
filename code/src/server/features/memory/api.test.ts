import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitOutput } from "../../git-env";
import { startMemory } from "./api";
import { getIndexedByDisk } from "./index-repo";
import { noteText } from "./index-test-kit";
import { type Env, setup, teardown } from "./store-test-kit";
import { vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

test("startMemory reconciles existing files, and stop commits an outside edit", async () => {
  const file = join(vaultDir(env.dir), "orgs/A/org/a.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, noteText("# A"));
  const stop = startMemory(env.db, { home: env.dir });
  expect(getIndexedByDisk(env.db, "orgs/A/org/a.md")).not.toBeNull();
  // FSEvents drops changes made in the first moments after a stream starts.
  await Bun.sleep(300);
  writeFileSync(file, noteText("# A\nedited"));
  for (const end = Date.now() + 2000; Date.now() < end; ) {
    if (env.db.query("SELECT 1 FROM note_writes WHERE op = 'outside'").get() !== null) break;
    await Bun.sleep(25);
  }
  await stop();
  expect(await gitOutput(vaultDir(env.dir), ["log", "--format=%s"])).toBe(
    "outside orgs/A/org/a.md\n",
  );
});

test("startMemory tightens a 0755 vault to 0700 and refuses a symlinked one", async () => {
  mkdirSync(vaultDir(env.dir), { recursive: true, mode: 0o755 });
  chmodSync(vaultDir(env.dir), 0o755);
  const stop = startMemory(env.db, { home: env.dir });
  await stop();
  expect(statSync(vaultDir(env.dir)).mode & 0o777).toBe(0o700);

  const other = mkdtempSync(join(tmpdir(), "harness-vault-link-"));
  const home = mkdtempSync(join(tmpdir(), "harness-vault-home-"));
  try {
    symlinkSync(other, vaultDir(home));
    expect(() => startMemory(env.db, { home })).toThrow(/not usable: not a real directory/);
    expect(statSync(other).mode & 0o777).not.toBe(0o000);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
