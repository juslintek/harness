import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNote } from "./frontmatter";
import { drainCommits, ensureVaultRepo } from "./git-log";
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
