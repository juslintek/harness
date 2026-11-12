import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyBatch, type BatchResult, type Change, parseData } from "./apply";
import { specOf, type TableSpec } from "./schema";
import { freshDb, hlcAt, seedProject, taskChange } from "./test-kit";

const tasks: TableSpec = (() => {
  const found = specOf("tasks");
  if (!found) throw new Error("no tasks table");
  return found;
})();

const task = (extra: object, id = "t-x"): Change => ({
  ...taskChange(id, hlcAt(100), "t"),
  data: JSON.stringify({ ...JSON.parse(taskChange(id, hlcAt(100), "t").data ?? "{}"), ...extra }),
});

function seeded(): Database {
  const db = freshDb();
  seedProject(db, { shared: true });
  return db;
}

const stateOf = (db: Database): object => ({
  tasks: db.query("SELECT * FROM tasks ORDER BY id").all(),
  tombstones: db.query("SELECT * FROM fed_tombstones").all(),
  applying: db.query("SELECT value FROM fed_state WHERE key = 'applying'").get(),
});

function run(changes: Change[]): { result: BatchResult; state: object } {
  const db = seeded();
  const result = applyBatch(db, changes);
  return { result, state: stateOf(db) };
}

// A pulled page is parsed and written again, so an infinite JSON number arrives as null and fails
// NOT NULL. A text rank stays text, and SQLite turns "1e999" into an infinite REAL. A task number
// from a peer decides the number of every task the org makes after it.
const hostile: [string, Change][] = [
  ["rank 1e999 as text", task({ rank: "1e999" })],
  ["rank -1e999 as text", task({ rank: "-1e999" })],
  ["number of 10 digits", task({ number: 1_000_000_000 })],
  [
    "number of 9 digits, which leaves no room below the chat link limit",
    task({ number: 999_999_999 }),
  ],
  ["number one past the cap", task({ number: 100_000_000 })],
  ["number past what a double holds exactly", task({ number: 2 ** 62 })],
  ["number as text", task({ number: "5000000000" })],
  ["number 0", task({ number: 0 })],
  ["number below zero", task({ number: -1 })],
];

const good = taskChange("t-ok", hlcAt(100), "ok");
const control = run([good]);

test.each(hostile)("%s: parseData refuses the row", (_name, bad) => {
  expect(parseData(tasks, bad)).toBeNull();
});

test.each(hostile)("%s: refused row by row, nothing stored, the page still lands", (_name, bad) => {
  expect(control.result).toEqual({ applied: 1, stale: 0, rejected: 0 });
  const attacked = run([bad, good]);
  expect(attacked.result).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(attacked.state).toEqual(control.state);
});

const accepted: [string, object][] = [
  ["rank 1.5", { rank: 1.5 }],
  ["rank below zero", { rank: -3 }],
  ["the largest finite rank", { rank: Number.MAX_VALUE }],
  ["the smallest rank above zero", { rank: Number.MIN_VALUE }],
  ["number 1", { number: 1 }],
  ["number at the cap", { number: 99_999_999 }],
];

test.each(accepted)("%s: accepted and stored as sent", (_name, extra) => {
  const change = task(extra);
  expect(parseData(tasks, change)).not.toBeNull();
  const db = seeded();
  expect(applyBatch(db, [change])).toEqual({ applied: 1, stale: 0, rejected: 0 });
  const stored = db.query<{ rank: number; number: number }, []>("SELECT rank, number FROM tasks");
  expect(stored.get()).toMatchObject(extra);
});
