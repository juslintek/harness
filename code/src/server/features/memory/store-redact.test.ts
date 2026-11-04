import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashText, serializeNote } from "./frontmatter";
import { drainCommits, ensureVaultRepo } from "./git-log";
import { listWrites } from "./index-log";
import { getIndexedByDisk } from "./index-repo";
import { searchNotes } from "./index-search";
import { noteText } from "./index-test-kit";
import { reconcile } from "./reconcile";
import { updateNote } from "./store";
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

// Reconcile audits what it indexes; these tests look at the rows of the edit that follows it.
function reconcileQuietly(): void {
  reconcile(env.db, env.dir);
  env.db.run("DELETE FROM note_writes");
}

async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 2000; Date.now() < end && !check(); ) await Bun.sleep(25);
}

test("reverting an outside edit with unknown previous text is invalid and keeps the file", () => {
  const file = put(noteText("# D\none"));
  reconcileQuietly();
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

test("an outside edit with secrets is redacted on disk, in the index and in git history", async () => {
  put(noteText("# D\nclean"));
  reconcileQuietly();
  await ensureVaultRepo(env.dir);
  // A commit still queued from the reconcile would otherwise snapshot the raw file first.
  await drainCommits();
  stop = watchVault(env.db, env.dir);
  await Bun.sleep(300);
  const raw = noteText(`# D\nkey ${AWS}\ntoken ${GH}`);
  const file = put(raw);
  await until(() => listWrites(env.db, "A", { limit: 5 }).length > 0);
  const text = await Bun.file(file).text();
  expect(text).not.toContain(AWS);
  expect(text).not.toContain(GH);
  const note = getIndexedByDisk(env.db, orgNote.disk);
  expect(note?.hash).toBe(hashText(text));
  expect(searchNotes(env.db, aliceA, { text: AWS })).toEqual([]);
  const rows = env.db.query("SELECT after_text, before_text FROM note_writes").all();
  expect(JSON.stringify(rows)).not.toContain(AWS);
  await Bun.sleep(500);
  expect(listWrites(env.db, "A", { limit: 5 }).length).toBe(1);
  await drainCommits();
  const log = Bun.spawnSync(["git", "log", "-p"], { cwd: vaultDir(env.dir) }).stdout.toString();
  expect(log).toContain("outside");
  expect(log).not.toContain(AWS);
  expect(log).not.toContain(GH);
});

test("an update carrying a secret reports redacted and a clean one does not", async () => {
  put(noteText("# D\nplain"));
  reconcileQuietly();
  const note = getIndexedByDisk(env.db, orgNote.disk);
  const c = ctx(aliceA);
  const u = updateNote(env.db, env.dir, c, note?.id as string, note?.hash as string, `# D\n${AWS}`);
  expect(u.redacted).toBe(true);
  expect(u.note.body).not.toContain(AWS);
  const next = updateNote(env.db, env.dir, c, u.note.id, u.note.hash, "# D\nagain");
  expect(next.redacted).toBe(false);
});

test("a secret nested in frontmatter extra is not written back by a later update", () => {
  const raw = serializeNote(
    { tags: [], type: "fact", sourceAgent: "bot", extra: { creds: { token: GH, list: [AWS] } } },
    "# D\nbody",
  );
  const file = put(raw);
  reconcile(env.db, env.dir);
  const note = getIndexedByDisk(env.db, orgNote.disk);
  updateNote(env.db, env.dir, ctx(aliceA), note?.id as string, note?.hash as string, "# D\nnew");
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(GH);
  expect(text).not.toContain(AWS);
});
