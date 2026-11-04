import "../../test-support/no-git-env";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashText, parseNote } from "./frontmatter";
import { listWrites } from "./index-log";
import { getIndexed } from "./index-repo";
import { backlinks } from "./index-search";
import { loc } from "./index-test-kit";
import { createNote, deleteNote, readNote, renameNote, updateNote } from "./store";
import { MemoryError, onMemoryChange } from "./store-kit";
import { aliceA, ctx, type Env, orgNote, setup, teardown } from "./store-test-kit";
import { readNoteFile } from "./vault";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => teardown(env));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MemoryError ? e.code : `other:${(e as Error).message}`;
  }
  return "none";
}

async function made(body = "# Deploy\nsteps") {
  return (await createNote(env.db, env.dir, ctx(aliceA, "run1"), orgNote, body)).note;
}

test("create writes the file, the index row and a write log row", async () => {
  const events: string[] = [];
  const off = onMemoryChange((e) => events.push(`${e.orgId}:${e.noteId}`));
  const note = await made();
  off();
  const text = readNoteFile(env.dir, orgNote.disk) as string;
  expect(text.startsWith("---\nid: ")).toBe(true);
  expect(parseNote(text).meta).toMatchObject({
    type: "fact",
    scope: "org",
    sourceAgent: "alice",
    confidence: 0.5,
  });
  expect(note.hash).toBe(hashText(text));
  expect(getIndexed(env.db, note.id)?.disk).toBe(orgNote.disk);
  const [w] = listWrites(env.db, "A", { limit: 5 });
  expect(w).toMatchObject({ op: "create", actor: "alice", runId: "run1", noteId: note.id });
  expect(events).toEqual([`A:${note.id}`]);
});

test("create twice is exists, classify supplies the type", async () => {
  const c = {
    ...ctx(aliceA),
    classify: async () => ({ type: "howto" as const, scope: "org" as const, confidence: 1 }),
  };
  const r = await createNote(env.db, env.dir, c, orgNote, "x");
  expect(r.note.type).toBe("howto");
  await expect(createNote(env.db, env.dir, c, orgNote, "y")).rejects.toMatchObject({
    code: "exists",
  });
});

test("update with a stale hash is a conflict and leaves the file alone", async () => {
  const note = await made();
  updateNote(env.db, env.dir, ctx(aliceA), note.id, note.hash, "# Deploy\nv2");
  const onDisk = readNoteFile(env.dir, orgNote.disk);
  expect(code(() => updateNote(env.db, env.dir, ctx(aliceA), note.id, note.hash, "stale"))).toBe(
    "conflict",
  );
  expect(readNoteFile(env.dir, orgNote.disk)).toBe(onDisk);
});

test("an edit on disk between read and update is a conflict", async () => {
  const note = await made();
  writeFileSync(join(env.dir, "memory", orgNote.disk), "edited outside\n");
  expect(code(() => updateNote(env.db, env.dir, ctx(aliceA), note.id, note.hash, "mine"))).toBe(
    "conflict",
  );
  expect(readNoteFile(env.dir, orgNote.disk)).toBe("edited outside\n");
});

test("secrets in body and frontmatter are redacted and reported", async () => {
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const gh = `ghp_${"a1B2".repeat(9)}`;
  const r = await createNote(env.db, env.dir, ctx(aliceA), orgNote, `key ${aws}\ntoken ${gh}`, {
    tags: [gh],
  });
  expect(r.redacted).toBe(true);
  const text = readNoteFile(env.dir, orgNote.disk) as string;
  expect(text).not.toContain(aws);
  expect(text).not.toContain(gh);
  const u = updateNote(env.db, env.dir, ctx(aliceA), r.note.id, r.note.hash, `again ${aws}`);
  expect(u.redacted).toBe(true);
  expect(readNoteFile(env.dir, orgNote.disk)).not.toContain(aws);
  const clean = updateNote(env.db, env.dir, ctx(aliceA), u.note.id, u.note.hash, "fine");
  expect(clean.redacted).toBe(false);
});

test("an agent cannot write global, a global admin can", async () => {
  const g = loc("global/g.md");
  await expect(createNote(env.db, env.dir, ctx(aliceA), g, "x")).rejects.toMatchObject({
    code: "forbidden",
  });
  const admin = { ...aliceA, canWriteGlobal: true };
  expect((await createNote(env.db, env.dir, ctx(admin), g, "x")).note.scope).toBe("global");
});

test("a global note change emits a null org while the audit row keeps the writer's org", async () => {
  const events: (string | null)[] = [];
  const off = onMemoryChange((e) => events.push(e.orgId));
  const admin = { ...aliceA, canWriteGlobal: true };
  await createNote(env.db, env.dir, ctx(admin), loc("global/g.md"), "x");
  off();
  expect(events).toEqual([null]);
  expect(listWrites(env.db, aliceA.orgId, { limit: 5 })[0]?.op).toBe("create");
});

test("delete removes file and index row and logs it", async () => {
  const note = await made();
  deleteNote(env.db, env.dir, ctx(aliceA), note.id, note.hash);
  expect(readNoteFile(env.dir, orgNote.disk)).toBeNull();
  expect(getIndexed(env.db, note.id)).toBeNull();
  expect(listWrites(env.db, "A", { limit: 5 })[0]?.op).toBe("delete");
});

test("rename keeps the id and backlinks, cannot change org or overwrite", async () => {
  const target = await made("# Deploy\nsteps");
  await createNote(env.db, env.dir, ctx(aliceA), loc("orgs/A/org/other.md"), "see [[Deploy]]");
  const to = loc("orgs/A/org/sub/deploy-v2.md");
  const moved = renameNote(env.db, env.dir, ctx(aliceA), target.id, target.hash, to);
  expect(moved.id).toBe(target.id);
  expect(readNoteFile(env.dir, orgNote.disk)).toBeNull();
  expect(readNote(env.db, env.dir, aliceA, target.id).path).toBe(to.disk);
  expect(backlinks(env.db, aliceA, target.id).map((n) => n.path)).toEqual(["orgs/A/org/other.md"]);
  expect(
    code(() =>
      renameNote(env.db, env.dir, ctx(aliceA), target.id, moved.hash, loc("orgs/B/org/x.md")),
    ),
  ).toBe("invalid");
  expect(
    code(() =>
      renameNote(env.db, env.dir, ctx(aliceA), target.id, moved.hash, loc("orgs/A/org/other.md")),
    ),
  ).toBe("exists");
});

test("rename leaves only the source file when removing it fails", async () => {
  const target = await made("# Deploy\nsteps");
  const to = loc("orgs/A/projects/pa/deploy.md");
  // Not an ancestor of the target: writing the target re-chmods its own parents to 0700.
  const sourceDir = dirname(join(env.dir, "memory", orgNote.disk));
  chmodSync(sourceDir, 0o555);
  try {
    expect(code(() => renameNote(env.db, env.dir, ctx(aliceA), target.id, target.hash, to))).toBe(
      "invalid",
    );
  } finally {
    chmodSync(sourceDir, 0o755);
  }
  expect(readNoteFile(env.dir, orgNote.disk)).not.toBeNull();
  expect(readNoteFile(env.dir, to.disk)).toBeNull();
  expect(getIndexed(env.db, target.id)?.disk).toBe(orgNote.disk);
});

test("readNote reindexes when the file changed on disk", async () => {
  const note = await made();
  const text = `---\nid: ${note.id}\ntags: []\n---\n\n# Deploy\nnew body\n`;
  writeFileSync(join(env.dir, "memory", orgNote.disk), text);
  const read = readNote(env.db, env.dir, aliceA, note.id);
  expect(read.body).toContain("new body");
  expect(getIndexed(env.db, note.id)?.hash).toBe(hashText(text));
});
