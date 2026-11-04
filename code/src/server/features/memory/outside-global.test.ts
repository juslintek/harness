import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWrite, listWrites } from "./index-log";
import { loc, noteText } from "./index-test-kit";
import { syncOutside } from "./outside";
import { createNote } from "./store";
import { revertWrite } from "./store-revert";
import { aliceA, ctx, type Env, setup, teardown } from "./store-test-kit";
import { readNoteFile, vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

const DISK = "global/shared.md";
const globalNote = loc("global/fresh.md");
const admin = { ...aliceA, canWriteGlobal: true };

function outsideGlobalEdit(): string {
  const file = join(vaultDir(env.dir), DISK);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, noteText("# Shared\nhand written"));
  syncOutside(env.db, env.dir, DISK);
  const row = env.db
    .query<{ id: string }, []>("SELECT id FROM note_writes WHERE org_id IS NULL")
    .get();
  return (row as { id: string }).id;
}

test("an outside edit of a global note is logged without an org, and only an instance admin sees it", () => {
  const id = outsideGlobalEdit();
  expect(listWrites(env.db, "A", { limit: 10 })).toEqual([]);
  expect(listWrites(env.db, "A", { limit: 10, includeGlobal: true }).map((w) => w.id)).toEqual([
    id,
  ]);
  expect(listWrites(env.db, "B", { limit: 10 })).toEqual([]);
  expect(getWrite(env.db, "A", id)).toBeNull();
  expect(getWrite(env.db, "A", id, true)?.id).toBe(id);
});

test("revert of a global write: a normal member is refused, an instance admin undoes it, an outside edit is refused", async () => {
  const outside = outsideGlobalEdit();
  expect(() => revertWrite(env.db, env.dir, ctx(admin), outside)).toThrow(/cannot be reverted/);
  await createNote(env.db, env.dir, ctx(admin), globalNote, "# Fresh");
  const id = (listWrites(env.db, "A", { limit: 1, includeGlobal: true })[0] as { id: string }).id;
  expect(() => revertWrite(env.db, env.dir, ctx(aliceA), id)).toThrow(/not allowed to write/);
  expect(readNoteFile(env.dir, globalNote.disk)).not.toBeNull();
  revertWrite(env.db, env.dir, ctx(admin), id);
  expect(readNoteFile(env.dir, globalNote.disk)).toBeNull();
});
