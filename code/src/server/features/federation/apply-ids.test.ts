import { expect, test } from "bun:test";
import { applyBatch, applyChange, type Change } from "./apply";
import { freshDb, hlcAt, seedProject, taskChange, taskDel } from "./test-kit";

const change = (table: string, rowId: string, op: "put" | "del", data: object | null): Change => ({
  project_id: "p1",
  table_name: table,
  row_id: rowId,
  op,
  hlc: hlcAt(100),
  origin_instance: "inst-b",
  data: data === null ? null : JSON.stringify(data),
});

const comment = (id: string): Change =>
  change("comments", id, "put", { id, task_id: "t1", author_id: null, body: "hi", created_at: 1 });
const dep = (rowId: string, taskId: string, dependsOn: string): Change =>
  change("task_deps", rowId, "put", { task_id: taskId, depends_on: dependsOn });

// A row id is the primary key joined with ":", so one that holds a colon, or too few parts, names no row.
const hostile: [string, Change][] = [
  ["tasks put", taskChange("a:b", hlcAt(100), "colon")],
  ["tasks del", taskDel("a:b", hlcAt(100))],
  ["comments put", comment("c:1")],
  ["comments del", change("comments", "c:1", "del", null)],
  ["task_deps put, colon in the task", dep("a:b:c", "a:b", "c")],
  ["task_deps put, colon in the dependency", dep("a:b:c", "a", "b:c")],
  ["task_deps del, three parts", change("task_deps", "a:b:c", "del", null)],
  ["task_deps del, one part", change("task_deps", "lonely", "del", null)],
];

function setup() {
  const db = freshDb();
  seedProject(db, { shared: true });
  return db;
}

const counts = (db: ReturnType<typeof freshDb>): number[] =>
  ["tasks", "comments", "task_deps", "fed_tombstones"].map(
    (t) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0,
  );

test.each(hostile)("a row id that does not fit the table key is rejected: %s", (_name, bad) => {
  const db = setup();
  applyChange(db, taskChange("t1", hlcAt(50), "parent"));
  const before = counts(db);
  expect(applyChange(db, bad)).toBe("rejected");
  expect(counts(db)).toEqual(before);
  db.close();
});

test.each(hostile)("a valid change in the same batch still applies: %s", (_name, bad) => {
  const db = setup();
  const result = applyBatch(db, [bad, taskChange("t2", hlcAt(100), "ok")]);
  expect(result).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(counts(db)).toEqual([1, 0, 0, 0]);
  expect(
    db.query<{ value: string }, []>("SELECT value FROM fed_state WHERE key = 'applying'").get()
      ?.value,
  ).toBe("0");
  db.close();
});

test("ordinary ids, single and composite, still apply and delete", () => {
  const db = setup();
  const batch = [
    taskChange("t1", hlcAt(100), "one"),
    taskChange("t2", hlcAt(100), "two"),
    dep("t1:t2", "t1", "t2"),
  ];
  expect(applyBatch(db, batch)).toEqual({ applied: 3, stale: 0, rejected: 0 });
  expect(counts(db)).toEqual([2, 0, 1, 0]);
  const gone = { ...change("task_deps", "t1:t2", "del", null), hlc: hlcAt(200) };
  expect(applyChange(db, gone)).toBe("applied");
  expect(counts(db)).toEqual([2, 0, 0, 1]);
  db.close();
});
