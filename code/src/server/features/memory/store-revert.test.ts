import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listWrites } from "./index-log";
import { createNote, deleteNote, readNote, updateNote } from "./store";
import { revertWrite } from "./store-revert";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

function lastWrite(): string {
  return (listWrites(env.db, "A", { limit: 1 })[0] as { id: string }).id;
}

test("reverting an update restores the old text and logs a revert", async () => {
  const c = ctx(aliceA);
  const first = (await createNote(env.db, env.dir, c, orgNote, "one")).note;
  const before = readNoteFile(env.dir, orgNote.disk);
  updateNote(env.db, env.dir, c, first.id, first.hash, "two");
  const r = revertWrite(env.db, env.dir, c, lastWrite());
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(before);
  expect(r.note.body).toContain("one");
  expect(listWrites(env.db, "A", { limit: 1 })[0]?.op).toBe("revert");
});

test("revert after a later edit is a conflict", async () => {
  const c = ctx(aliceA);
  const first = (await createNote(env.db, env.dir, c, orgNote, "one")).note;
  const second = updateNote(env.db, env.dir, c, first.id, first.hash, "two").note;
  const target = lastWrite();
  updateNote(env.db, env.dir, c, second.id, second.hash, "three");
  expect(() => revertWrite(env.db, env.dir, c, target)).toThrow(
    expect.objectContaining({ code: "conflict" }),
  );
  expect(readNoteFile(env.dir, orgNote.disk)).toContain("three");
});

test("a create is reverted by delete and a delete by recreate", async () => {
  const c = ctx(aliceA);
  const note = (await createNote(env.db, env.dir, c, orgNote, "one")).note;
  const created = readNoteFile(env.dir, orgNote.disk);
  revertWrite(env.db, env.dir, c, lastWrite());
  expect(readNoteFile(env.dir, orgNote.disk)).toBeNull();
  expect(() => readNote(env.db, env.dir, aliceA, note.id)).toThrow();

  const again = (await createNote(env.db, env.dir, c, orgNote, "two")).note;
  deleteNote(env.db, env.dir, c, again.id, again.hash);
  const restored = revertWrite(env.db, env.dir, c, lastWrite());
  expect(restored.note.id).toBe(again.id);
  expect(readNote(env.db, env.dir, aliceA, again.id).body).toContain("two");
  expect(created).not.toBeNull();
});

test("reverting a delete over a recreated file is a conflict", async () => {
  const c = ctx(aliceA);
  const note = (await createNote(env.db, env.dir, c, orgNote, "one")).note;
  deleteNote(env.db, env.dir, c, note.id, note.hash);
  const del = lastWrite();
  writeFileSync(join(env.dir, "memory", orgNote.disk), "someone else\n");
  expect(() => revertWrite(env.db, env.dir, c, del)).toThrow(
    expect.objectContaining({ code: "conflict" }),
  );
});
