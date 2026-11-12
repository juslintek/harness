import { expect, test } from "bun:test";
import { applyBatch, type Change, parseData } from "./apply";
import { specOf, type TableSpec } from "./schema";
import { freshDb, hlcAt, seedProject, taskChange } from "./test-kit";

const notes: TableSpec = (() => {
  const found = specOf("notes");
  if (!found) throw new Error("no notes table");
  return found;
})();

const noteRow = (extra: object = {}, id = "n1"): Change => ({
  project_id: "p1",
  table_name: "notes",
  row_id: id,
  op: "put",
  hlc: hlcAt(100),
  origin_instance: "inst-b",
  data: JSON.stringify({
    id,
    disk: `orgs/o1/projects/p1/${id}.md`,
    scope: "project",
    org_id: "o1",
    project_id: "p1",
    type: "fact",
    title: "t",
    tags: "[]",
    confidence: null,
    created: 1,
    updated: 1,
    hash: "h",
    slug: id,
    title_key: id,
    ...extra,
  }),
});

function receive(changes: Change[]): { stored: string[]; result: ReturnType<typeof applyBatch> } {
  const db = freshDb();
  seedProject(db, { shared: true });
  const result = applyBatch(db, changes);
  const stored = db
    .query<{ id: string }, []>("SELECT id FROM notes ORDER BY id")
    .all()
    .map((note) => note.id);
  db.close();
  return { stored, result };
}

test("a note whose disk is a number is refused and the page still lands", () => {
  expect(parseData(notes, noteRow({ disk: 5 }))).toBeNull();
  const { stored, result } = receive([noteRow({ disk: 5 }), taskChange("t-ok", hlcAt(100), "ok")]);
  expect(result).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(stored).toEqual([]);
});

// Each row keeps a project path and the ids that go with it, so the scope is the only thing that
// sets it apart from the project note next to it.
const foreignScopes = ["global", "org", "agent"];

test.each(foreignScopes)("a peer note of scope %s is refused", (scope) => {
  expect(parseData(notes, noteRow({ scope }))).toBeNull();
});

test("peer notes of other scopes are refused and a project note in the same batch applies", () => {
  const foreign = foreignScopes.map((scope) => noteRow({ scope }, `n-${scope}`));
  expect(parseData(notes, noteRow({}, "n-project"))).not.toBeNull();
  const { stored, result } = receive([...foreign, noteRow({}, "n-project")]);
  expect(result).toEqual({ applied: 1, stale: 0, rejected: foreignScopes.length });
  expect(stored).toEqual(["n-project"]);
});
