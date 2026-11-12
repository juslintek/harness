import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyBatch, type BatchResult, type Change, parseData } from "./apply";
import { permitInbound } from "./inbound";
import { specOf, type TableSpec } from "./schema";
import { freshDb, hlcAt, seedProject } from "./test-kit";

const messages: TableSpec = (() => {
  const found = specOf("messages");
  if (!found) throw new Error("no messages table");
  return found;
})();

// The largest millisecond value a Date can hold.
const MAX_DATE = 8.64e15;
// Taken once so every build of the honest row is the same row.
const NOW = Date.now();
const UUID_V7 = "0190a5b2-7c3e-7d4f-8a1b-2c3d4e5f6a7b";

const message = (extra: object = {}, id = "m1"): Change => ({
  project_id: "p1",
  table_name: "messages",
  row_id: id,
  op: "put",
  hlc: hlcAt(100),
  origin_instance: "inst-b",
  data: JSON.stringify({
    id,
    channel_id: "ch1",
    thread_root_id: null,
    author_id: "m-bee",
    body: "hi",
    created_at: 1_700_000_000_000,
    edited_at: null,
    ...extra,
  }),
});

const withId = (id: string): Change => message({ id }, id);

// A project channel of the local org, and a member of the peer's stub org to write in it.
function seeded(): Database {
  const db = freshDb();
  seedProject(db, { shared: true });
  db.run(
    "INSERT INTO channels (id, org_id, kind, name, project_id, created_at) VALUES ('ch1', 'o1', 'project', 'Eng', 'p1', 1)",
  );
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('m-bee', 'o2', 'human', 'remote:m-bee', 'bee', 'Bee', 'member', 1)`,
  );
  return db;
}

const stateOf = (db: Database): object => ({
  messages: db.query("SELECT * FROM messages ORDER BY id").all(),
  tombstones: db.query("SELECT * FROM fed_tombstones").all(),
  applying: db.query("SELECT value FROM fed_state WHERE key = 'applying'").get(),
});

// What a peer leaves behind is everything that differs from the same page without its bad row.
const honest = (): Change => message({ created_at: NOW, edited_at: NOW + 1 }, "m-ok");

function viaApply(changes: Change[]): { result: BatchResult; state: object } {
  const db = seeded();
  const result = applyBatch(db, changes);
  return { result, state: stateOf(db) };
}

function viaPermit(changes: Change[]): { allowed: string[]; result: BatchResult; state: object } {
  const db = seeded();
  const { allowed } = permitInbound(db, "inst-b", changes);
  const result = applyBatch(db, allowed);
  return { allowed: allowed.map((c) => c.row_id), result, state: stateOf(db) };
}

// Each of these is a valid STRICT INTEGER or TEXT value that SQLite stores as it comes.
const hostile: [string, Change][] = [
  ["created_at 9e15", message({ created_at: 9e15 })],
  ["created_at -9e15", message({ created_at: -9e15 })],
  ["created_at one past the Date range", message({ created_at: MAX_DATE + 1 })],
  ["created_at one before the Date range", message({ created_at: -MAX_DATE - 1 })],
  ["created_at 0", message({ created_at: 0 })],
  ["created_at -1", message({ created_at: -1 })],
  ["created_at as text", message({ created_at: "1700000000000" })],
  ["edited_at 9e15", message({ edited_at: 9e15 })],
  ["edited_at -9e15", message({ edited_at: -9e15 })],
  ["edited_at one past the Date range", message({ edited_at: MAX_DATE + 1 })],
  ["edited_at 0", message({ edited_at: 0 })],
  ["edited_at as text", message({ edited_at: "1700000000000" })],
  ["id with a dot", withId("m.dot")],
  ["id with a space", withId("m x")],
  ["id with a slash", withId("m/x")],
  ["id outside ASCII", withId("é1")],
  ["id of 65 characters", withId("a".repeat(65))],
  ["empty id", withId("")],
];

const control = viaApply([honest()]);

test.each(hostile)("%s: parseData refuses the row", (_name, bad) => {
  expect(parseData(messages, bad)).toBeNull();
});

test.each(hostile)("%s: refused row by row, nothing stored, the page still lands", (_name, bad) => {
  expect(control.result).toEqual({ applied: 1, stale: 0, rejected: 0 });
  const attacked = viaApply([bad, honest()]);
  expect(attacked.result).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(attacked.state).toEqual(control.state);
});

test.each(hostile)("%s: the permission filter drops it before apply", (_name, bad) => {
  const attacked = viaPermit([bad, honest()]);
  expect(attacked.allowed).toEqual(["m-ok"]);
  expect(attacked.result).toEqual({ applied: 1, stale: 0, rejected: 0 });
  expect(attacked.state).toEqual(control.state);
});

// Honest rows: ids are UUIDv7, times are Date.now() milliseconds, and the older test fixtures use
// short ids. The rest sit exactly on a boundary of what the chat view and its cursor accept.
const accepted: [string, Change][] = [
  ["a UUIDv7 id and Date.now() times", message({ created_at: NOW, edited_at: NOW }, UUID_V7)],
  ["a short fixture id", message({}, "m1")],
  ["an id of 64 characters", withId("a".repeat(64))],
  ["an id with underscores and capitals", withId("A_b-9")],
  ["created_at 1", message({ created_at: 1 })],
  ["created_at at the end of the Date range", message({ created_at: MAX_DATE })],
  ["edited_at 1", message({ edited_at: 1 })],
  ["edited_at at the end of the Date range", message({ edited_at: MAX_DATE })],
  ["edited_at left out", message({ edited_at: undefined })],
];

test.each(accepted)("%s: accepted and stored as sent", (_name, change) => {
  expect(parseData(messages, change)).not.toBeNull();
  const db = seeded();
  expect(applyBatch(db, [change])).toEqual({ applied: 1, stale: 0, rejected: 0 });
  const sent: { id: string; created_at: number } = JSON.parse(change.data ?? "{}");
  expect(db.query("SELECT created_at FROM messages WHERE id = ?").get(sent.id)).toEqual({
    created_at: sent.created_at,
  });
});

test("a reply keeps its root and a message thread still applies", () => {
  const db = seeded();
  const reply = message({ thread_root_id: "m1", created_at: 1_700_000_000_001 }, "m2");
  expect(applyBatch(db, [message(), reply])).toEqual({ applied: 2, stale: 0, rejected: 0 });
});
