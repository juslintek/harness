import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loc } from "./index-test-kit";
import { createNote, deleteNote, renameNote, updateNote } from "./store";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile, setBeforeSwapHook, vaultDir } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(async () => {
  setBeforeSwapHook(null);
  await teardown(env);
});

const OUTSIDE = "---\nid: x\n---\nedited in an editor\n";

// Fires once, after checkBase has passed and before the rename or unlink.
function editBetweenCheckAndSwap(file: string): void {
  setBeforeSwapHook(() => {
    setBeforeSwapHook(null);
    writeFileSync(file, OUTSIDE);
  });
}

const fileOf = (disk: string) => join(vaultDir(env.dir), disk);

async function seeded() {
  const made = (await createNote(env.db, env.dir, ctx(aliceA), orgNote, "one")).note;
  return made;
}

test("an outside edit between the base check and the rename is a conflict and survives", async () => {
  const n = await seeded();
  editBetweenCheckAndSwap(fileOf(orgNote.disk));
  expect(() => updateNote(env.db, env.dir, ctx(aliceA), n.id, n.hash, "two")).toThrow(
    /changed since/,
  );
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(OUTSIDE);
  expect(readdirSync(dirname(fileOf(orgNote.disk))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("an outside edit before a delete keeps the file", async () => {
  const n = await seeded();
  editBetweenCheckAndSwap(fileOf(orgNote.disk));
  expect(() => deleteNote(env.db, env.dir, ctx(aliceA), n.id, n.hash)).toThrow(/changed since/);
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(OUTSIDE);
});

test("an outside edit before a rename removes the copy and keeps the source", async () => {
  const n = await seeded();
  const to = loc("orgs/A/org/moved.md");
  let calls = 0;
  // The first swap is the write of the copy; the edit lands on the second, the unlink of the source.
  setBeforeSwapHook(() => {
    if (++calls === 2) writeFileSync(fileOf(orgNote.disk), OUTSIDE);
  });
  expect(() => renameNote(env.db, env.dir, ctx(aliceA), n.id, n.hash, to)).toThrow(/changed since/);
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(OUTSIDE);
  expect(existsSync(fileOf(to.disk))).toBe(false);
});
