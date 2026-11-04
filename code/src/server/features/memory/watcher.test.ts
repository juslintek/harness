import "../../test-support/no-git-env";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureVaultRepo } from "./git-log";
import { listWrites } from "./index-log";
import { getIndexedByDisk } from "./index-repo";
import { noteText } from "./index-test-kit";
import { createNote } from "./store";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { vaultDir } from "./vault";
import { watchVault } from "./watcher";

let env: Env;
let stop: () => void;
beforeEach(async () => {
  env = setup();
  mkdirSync(vaultDir(env.dir), { recursive: true });
  stop = watchVault(env.db, env.dir);
  // FSEvents drops changes made in the first moments after a stream starts.
  await Bun.sleep(300);
});
afterEach(async () => {
  stop();
  await teardown(env);
});

function put(rel: string, text: string): void {
  const file = join(vaultDir(env.dir), rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function until(check: () => boolean, ms = 2000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

function ops(db: Database): string[] {
  return listWrites(db, "A", { limit: 20 }).map((w) => `${w.op}:${w.actor}`);
}

test("an outside write is indexed and logged as outside", async () => {
  put(orgNote.disk, noteText("# Deploy\nfrom vim"));
  expect(await until(() => getIndexedByDisk(env.db, orgNote.disk) !== null)).toBe(true);
  expect(await until(() => ops(env.db).includes("outside:outside"))).toBe(true);
});

test("an outside delete removes the row", async () => {
  put(orgNote.disk, noteText("# Deploy\nx"));
  expect(await until(() => getIndexedByDisk(env.db, orgNote.disk) !== null)).toBe(true);
  rmSync(join(vaultDir(env.dir), orgNote.disk));
  expect(await until(() => getIndexedByDisk(env.db, orgNote.disk) === null)).toBe(true);
});

test("own writes are not logged again as outside", async () => {
  await createNote(env.db, env.dir, ctx(aliceA), orgNote, "mine");
  await Bun.sleep(600);
  expect(ops(env.db)).toEqual(["create:alice"]);
});

test("a symlink dropped in the vault is not indexed", async () => {
  const outside = join(env.dir, "elsewhere.md");
  writeFileSync(outside, noteText("# Leak"));
  mkdirSync(join(vaultDir(env.dir), "orgs/A/org"), { recursive: true });
  symlinkSync(outside, join(vaultDir(env.dir), "orgs/A/org/link.md"));
  put("orgs/A/org/real.md", noteText("# Real"));
  expect(await until(() => getIndexedByDisk(env.db, "orgs/A/org/real.md") !== null)).toBe(true);
  expect(getIndexedByDisk(env.db, "orgs/A/org/link.md")).toBeNull();
});

test("writes inside .git and tmp files are ignored", async () => {
  await ensureVaultRepo(env.dir);
  put(".git/config.md", noteText("# Git"));
  put("orgs/A/org/x.md.abc.tmp", "partial");
  put("orgs/A/org/probe.md", noteText("# Probe"));
  expect(await until(() => getIndexedByDisk(env.db, "orgs/A/org/probe.md") !== null)).toBe(true);
  expect(env.db.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 1 });
});
