import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashText } from "./frontmatter";
import { listWrites } from "./index-log";
import { getIndexedByDisk } from "./index-repo";
import { searchNotes } from "./index-search";
import { noteText } from "./index-test-kit";
import { reconcile } from "./reconcile";
import { readNote, updateNote } from "./store";
import { revertWrite } from "./store-revert";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { vaultDir } from "./vault";
import { watchVault } from "./watcher";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const GH = `ghp_${"a1B2".repeat(9)}`;
let env: Env;
let stop: (() => void) | null = null;
beforeEach(() => {
  env = setup();
});
afterEach(async () => {
  stop?.();
  stop = null;
  await teardown(env);
});

function put(text: string): string {
  const file = join(vaultDir(env.dir), orgNote.disk);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 2000; Date.now() < end && !check(); ) await Bun.sleep(25);
}

test("reverting an outside edit with unknown previous text is invalid and keeps the file", () => {
  const file = put(noteText("# D\none"));
  reconcile(env.db, env.dir);
  stop = watchVault(env.db, env.dir);
  return (async () => {
    await Bun.sleep(300);
    const edited = noteText("# D\ntwo");
    writeFileSync(file, edited);
    await until(() => listWrites(env.db, "A", { limit: 5 }).length > 0);
    const [w] = listWrites(env.db, "A", { limit: 5 });
    expect(w?.op).toBe("outside");
    expect(() => revertWrite(env.db, env.dir, ctx(aliceA), w?.id as string)).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
    expect(await Bun.file(file).text()).toBe(edited);
  })();
});

test("an outside edit with secrets is stored, indexed and served redacted, disk untouched", async () => {
  put(noteText("# D\nclean"));
  reconcile(env.db, env.dir);
  stop = watchVault(env.db, env.dir);
  await Bun.sleep(300);
  const raw = noteText(`# D\nkey ${AWS}\ntoken ${GH}`);
  const file = put(raw);
  await until(() => listWrites(env.db, "A", { limit: 5 }).length > 0);
  const note = getIndexedByDisk(env.db, orgNote.disk);
  expect(note?.hash).toBe(hashText(raw));
  expect(searchNotes(env.db, aliceA, { text: AWS })).toEqual([]);
  const rows = env.db.query("SELECT after_text, before_text FROM note_writes").all();
  expect(JSON.stringify(rows)).not.toContain(AWS);
  expect(JSON.stringify(rows)).not.toContain(GH);
  const view = readNote(env.db, env.dir, aliceA, note?.id as string);
  expect(view.body).not.toContain(AWS);
  expect(view.hash).toBe(hashText(raw));
  expect(await Bun.file(file).text()).toBe(raw);
  await Bun.sleep(500);
  expect(listWrites(env.db, "A", { limit: 5 }).length).toBe(1);
  const u = updateNote(env.db, env.dir, ctx(aliceA), view.id, view.hash, "fresh");
  expect(u.note.body).toBe("fresh\n".trimEnd());
  const stored = env.db.query("SELECT before_text FROM note_writes WHERE op = 'update'").get();
  expect(JSON.stringify(stored)).not.toContain(GH);
});
