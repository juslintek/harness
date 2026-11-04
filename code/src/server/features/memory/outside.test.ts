import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNote } from "./frontmatter";
import { drainCommits, ensureVaultRepo, queueCommit } from "./git-log";
import { listWrites } from "./index-log";
import { getIndexedByDisk } from "./index-repo";
import { loc, noteText } from "./index-test-kit";
import { syncOutside } from "./outside";
import { createNote, readNote } from "./store";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile, vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

function put(disk: string, text: string): void {
  const file = join(vaultDir(env.dir), disk);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const outsideRows = () => listWrites(env.db, "A", { limit: 20 }).filter((w) => w.op === "outside");

test("a newcomer claiming a taken id gets a fresh id written into its own file", () => {
  put("orgs/A/org/first.md", noteText("first", { id: "dup" }));
  put("orgs/A/org/second.md", noteText("second", { id: "dup" }));
  syncOutside(env.db, env.dir, "orgs/A/org/first.md");
  const second = syncOutside(env.db, env.dir, "orgs/A/org/second.md");
  expect(getIndexedByDisk(env.db, "orgs/A/org/first.md")?.id).toBe("dup");
  expect(second?.id).not.toBe("dup");
  const onDisk = parseNote(readNoteFile(env.dir, "orgs/A/org/second.md") as string);
  expect(onDisk.meta.id).toBe(second?.id as string);
  expect(syncOutside(env.db, env.dir, "orgs/A/org/second.md")?.id).toBe(second?.id as string);
  expect(env.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a read before the watcher leaves exactly one outside row and a commit", async () => {
  await ensureVaultRepo(env.dir);
  const made = (await createNote(env.db, env.dir, ctx(aliceA), orgNote, "# Deploy\nsteps")).note;
  const rows = outsideRows().length;
  put(orgNote.disk, noteText("# Deploy\nedited by hand", { id: made.id }));
  expect(readNote(env.db, env.dir, aliceA, made.id).body).toContain("edited by hand");
  expect(syncOutside(env.db, env.dir, orgNote.disk)?.id).toBe(made.id);
  expect(outsideRows().length).toBe(rows + 1);
  await drainCommits();
  const head = Bun.spawnSync(["git", "show", `HEAD:${orgNote.disk}`], { cwd: vaultDir(env.dir) });
  expect(head.stdout.toString()).toContain("edited by hand");
});

test("a read that finds the file deleted leaves one outside row and drops the note", async () => {
  const made = (await createNote(env.db, env.dir, ctx(aliceA), orgNote, "# Deploy\nsteps")).note;
  rmSync(join(vaultDir(env.dir), orgNote.disk));
  expect(() => readNote(env.db, env.dir, aliceA, made.id)).toThrow();
  expect(syncOutside(env.db, env.dir, orgNote.disk)).toBeNull();
  expect(outsideRows()).toHaveLength(1);
  expect(getIndexedByDisk(env.db, loc(orgNote.disk).disk)).toBeNull();
});

test("a commit queued by a harness write never snapshots a raw outside edit", async () => {
  await ensureVaultRepo(env.dir);
  const key = "AKIAIOSFODNN7EXAMPLE";
  await createNote(env.db, env.dir, ctx(aliceA), orgNote, "# Deploy\nsteps");
  put("orgs/A/org/typed.md", noteText(`# Typed\nkey ${key}`));
  await createNote(env.db, env.dir, ctx(aliceA), loc("orgs/A/org/two.md"), "# Two\nx");
  await drainCommits();
  const log = Bun.spawnSync(["git", "log", "-p"], { cwd: vaultDir(env.dir) }).stdout.toString();
  expect(log).toContain("typed.md");
  expect(log).not.toContain(key);
  expect(readNoteFile(env.dir, "orgs/A/org/typed.md")).not.toContain(key);
});

test("a commit never stores a secret, whether the scrub throws or is skipped", async () => {
  await ensureVaultRepo(env.dir);
  const key = "AKIAIOSFODNN7EXAMPLE";
  put("orgs/A/org/raw.md", noteText(`# Raw\nkey ${key}`));
  // No db: nothing scrubs the file, so only the staged-blob check stands between it and history.
  queueCommit(env.dir, "no scrub");
  await drainCommits();
  put("orgs/A/org/raw2.md", noteText(`# Raw2\nkey ${key}`));
  // A closed db makes the syncer throw, which must stop the commit rather than skip the check.
  queueCommit(env.dir, "closed db", env.db);
  env.db.close();
  await drainCommits();
  const log = Bun.spawnSync(["git", "log", "-p"], { cwd: vaultDir(env.dir) }).stdout.toString();
  expect(log).not.toContain(key);
});

test("a note pasted with another note's id keeps its own id and gets its frontmatter fixed", () => {
  put("orgs/A/org/one.md", noteText("one", { id: "id-one" }));
  put("orgs/A/org/two.md", noteText("two", { id: "id-two" }));
  syncOutside(env.db, env.dir, "orgs/A/org/one.md");
  syncOutside(env.db, env.dir, "orgs/A/org/two.md");
  put("orgs/A/org/two.md", noteText("two edited", { id: "id-one" }));
  expect(syncOutside(env.db, env.dir, "orgs/A/org/two.md")?.id).toBe("id-two");
  expect(getIndexedByDisk(env.db, "orgs/A/org/one.md")?.id).toBe("id-one");
  const text = readNoteFile(env.dir, "orgs/A/org/two.md") as string;
  expect(parseNote(text).meta.id).toBe("id-two");
});
