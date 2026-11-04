import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { listWrites } from "./index-log";
import { loc } from "./index-test-kit";
import { createNote, deleteNote, readNote, renameNote, updateNote } from "./store";
import { revertWrite } from "./store-revert";
import { aliceA, bobB, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

function rejects(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "other";
  }
  return "none";
}

test("a viewer from another org cannot touch an org A note by id", async () => {
  const { note } = await createNote(env.db, env.dir, ctx(aliceA), orgNote, "secret plan");
  const before = readNoteFile(env.dir, orgNote.disk);
  const writeId = (listWrites(env.db, "A", { limit: 1 })[0] as { id: string }).id;
  const b = ctx(bobB);
  const codes = [
    rejects(() => readNote(env.db, env.dir, bobB, note.id)),
    rejects(() => updateNote(env.db, env.dir, b, note.id, note.hash, "x")),
    rejects(() => deleteNote(env.db, env.dir, b, note.id, note.hash)),
    rejects(() => renameNote(env.db, env.dir, b, note.id, note.hash, loc("orgs/B/org/x.md"))),
    rejects(() => revertWrite(env.db, env.dir, b, writeId)),
  ];
  expect(codes.every((c) => c === "not_found" || c === "forbidden")).toBe(true);
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(before);
});

test("a viewer cannot create inside another org", async () => {
  await expect(createNote(env.db, env.dir, ctx(bobB), orgNote, "x")).rejects.toMatchObject({
    code: "forbidden",
  });
});
