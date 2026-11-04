import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
