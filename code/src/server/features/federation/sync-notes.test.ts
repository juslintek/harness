import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createNote,
  deleteNote,
  getIndexedByDisk,
  projectSlugs,
  readNoteText,
  resolveNotePath,
  searchNotes,
  updateNote,
  type Viewer,
} from "../memory/api";
import { bootNode, type Node, pairNodes, pull, type Seed, seedProject, shareTo } from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;
let viewer: Viewer;
let disk = "";

const search = (node: Node, text: string): string[] =>
  searchNotes(node.db, viewer, { text }).map((n) => n.disk);

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  viewer = {
    orgId: seed.orgId,
    memberId: null,
    projectIds: [seed.projectId],
    canWriteGlobal: false,
    canWrite: true,
    actor: "ann",
  };
  await shareTo(a, seed, b, "write");
  await pull(b, a);
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("a project note created on the home arrives with its body and can be searched", async () => {
  const loc = resolveNotePath(
    "/memories/project/ENG/plan.md",
    viewer,
    projectSlugs(a.db, seed.orgId),
  );
  if (loc === null || loc === "dir") throw new Error("bad path");
  disk = loc.disk;
  await createNote(a.db, a.home, { viewer, runId: null }, loc, "# Plan\n\nship the zebra release");
  await pull(b, a);
  expect(search(b, "zebra")).toEqual([disk]);
  expect(readNoteText(b.home, disk)).toBe(readNoteText(a.home, disk));
  expect(getIndexedByDisk(b.db, disk)?.hash).toBe(getIndexedByDisk(a.db, disk)?.hash);
});

test("a note edited on the copy with a write grant reaches the home", async () => {
  const note = getIndexedByDisk(b.db, disk);
  updateNote(
    b.db,
    b.home,
    { viewer, runId: null },
    note?.id as string,
    note?.hash as string,
    "# Plan\n\nship the giraffe release",
  );
  await pull(a, b);
  expect(search(a, "giraffe")).toEqual([disk]);
  expect(search(a, "zebra")).toEqual([]);
  expect(readNoteText(a.home, disk)).toBe(readNoteText(b.home, disk));
});

test("deleting the note on the home removes its file and index entry on the copy", async () => {
  const note = getIndexedByDisk(a.db, disk);
  deleteNote(a.db, a.home, { viewer, runId: null }, note?.id as string, note?.hash as string);
  await pull(b, a);
  expect(getIndexedByDisk(b.db, disk)).toBeNull();
  expect(readNoteText(b.home, disk)).toBeNull();
  expect(search(b, "giraffe")).toEqual([]);
});
