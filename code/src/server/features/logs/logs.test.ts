import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  appendEvent,
  type EventKind,
  listRunEvents,
  readBody,
  sealSegments,
  searchEvents,
} from "./api";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-logs-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function count(table: string): number {
  return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
}

function add(body: string, extra: { runId?: string; command?: string } = {}): number {
  const kind: EventKind = "message";
  const res = appendEvent(db, { kind, runId: "r1", body, ...extra });
  if (!res) throw new Error("unexpected duplicate");
  return res.rowid;
}

test("appendEvent then readBody returns redacted body before and after sealSegments", () => {
  const rowid = add("use key sk-ant-api03-abcDEF123456_xyz please");
  const expected = "use key [REDACTED:anthropic-key] please";
  expect(readBody(db, rowid)).toBe(expected);
  expect(sealSegments(db, { runId: "r1" })).toBe(1);
  expect(readBody(db, rowid)).toBe(expected);
});

test("sealSegments packs a run's payloads into one zstd frame and empties pending_payloads", () => {
  const first = add("héllo wörld");
  const second = add("second body");
  add("other run", { runId: "r2" });
  expect(sealSegments(db, { runId: "r1" })).toBe(1);
  expect(count("segments")).toBe(1);
  expect(count("pending_payloads")).toBe(1);
  expect(readBody(db, first)).toBe("héllo wörld");
  expect(readBody(db, second)).toBe("second body");
  const events = listRunEvents(db, "r1");
  const segmentIds = new Set(events.map((e) => e.segmentId));
  expect(segmentIds.size).toBe(1);
  expect(segmentIds.has(null)).toBe(false);
});

test("sealSegments without runId only seals runs over minBytes", () => {
  add("tiny");
  expect(sealSegments(db)).toBe(0);
  expect(sealSegments(db, { minBytes: 1 })).toBe(1);
});

test("searchEvents finds a word in a sealed body and a path fragment in commands", () => {
  const sealed = add("the quick brown fox jumps over the lazy dog");
  sealSegments(db, { runId: "r1" });
  const withCommand = add("ran it", { command: "cat /tmp/foo_bar_baz" });
  const byWord = searchEvents(db, "quick");
  expect(byWord.map((h) => h.rowid)).toEqual([sealed]);
  expect(byWord[0]?.snippet).toContain("quick");
  const byPath = searchEvents(db, "o_bar");
  expect(byPath.map((h) => h.rowid)).toEqual([withCommand]);
  expect(byPath[0]?.snippet).toContain("foo_bar_baz");
});

test("searchEvents does not throw on FTS syntax characters", () => {
  add("plain text");
  expect(() => searchEvents(db, 'a "b" NEAR( * -')).not.toThrow();
});

test("duplicate dedupeKey returns null", () => {
  expect(appendEvent(db, { kind: "run", dedupeKey: "k1" })).not.toBeNull();
  expect(appendEvent(db, { kind: "run", dedupeKey: "k1" })).toBeNull();
  expect(count("events")).toBe(1);
});

test("UPDATE of kind throws, UPDATE of segment_id works, DELETE throws", () => {
  add("x");
  expect(() => db.run("UPDATE events SET kind = 'error'")).toThrow(/append-only/);
  db.run("UPDATE events SET segment_id = 's', seg_offset = 0, seg_len = 1");
  expect(() => db.run("DELETE FROM events")).toThrow(/append-only/);
  db.run("INSERT INTO log_flags (key, value) VALUES ('retention', '1')");
  db.run("DELETE FROM events");
  expect(count("events")).toBe(0);
});

test("REPLACE of an existing id or dedupe_key and UPDATE of rowid throw", () => {
  const first = appendEvent(db, { kind: "run", dedupeKey: "k" });
  const cols = "(id, ts, kind, dedupe_key)";
  expect(() =>
    db.run(`REPLACE INTO events ${cols} VALUES (?, 1, 'run', 'other')`, [first?.id ?? ""]),
  ).toThrow(/append-only/);
  expect(() => db.run(`REPLACE INTO events ${cols} VALUES ('new', 1, 'run', 'k')`)).toThrow(
    /append-only/,
  );
  expect(() => db.run("UPDATE events SET rowid = 99")).toThrow(/append-only/);
  expect(count("events")).toBe(1);
});

test("INSERT OR REPLACE on an existing rowid throws and keeps the original row", () => {
  const first = appendEvent(db, { kind: "run" });
  expect(() =>
    db.run("INSERT OR REPLACE INTO events (rowid, id, ts, kind) VALUES (?, 'zz', 1, 'run')", [
      first?.rowid ?? 0,
    ]),
  ).toThrow(/append-only/);
  const row = db.query<{ id: string }, []>("SELECT id FROM events").all();
  expect(row).toEqual([{ id: first?.id ?? "" }]);
});

test("a missing kind throws instead of reading as a duplicate", () => {
  expect(() => appendEvent(db, {} as never)).toThrow();
});

test("secrets in command, toolName and guardRule never reach the db or either index", () => {
  const secret = "abcdef123456tok";
  appendEvent(db, {
    kind: "tool_call",
    command: `curl -H 'Authorization: Bearer ${secret}' https://x`,
    toolName: `tool --password ${secret}`,
    guardRule: `PASSWORD=${secret}`,
    body: `Authorization: Bearer ${secret}`,
  });
  const row = db
    .query<{ command: string; gen_ai_tool_name: string; guard_rule: string }, []>(
      "SELECT command, gen_ai_tool_name, guard_rule FROM events",
    )
    .get();
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(searchEvents(db, secret)).toEqual([]);
  expect(searchEvents(db, "Authorization")).toHaveLength(1);
});

test("pending payloads survive closing and reopening the db file", () => {
  const rowid = add("survives restart");
  db.close();
  db = openDb(join(dir, "t.db"));
  expect(readBody(db, rowid)).toBe("survives restart");
  expect(sealSegments(db, { runId: "r1" })).toBe(1);
  expect(readBody(db, rowid)).toBe("survives restart");
});

test("listRunEvents returns events in order and honours afterRowid", () => {
  const a = add("a");
  const b = add("b");
  expect(listRunEvents(db, "r1").map((e) => e.rowid)).toEqual([a, b]);
  expect(listRunEvents(db, "r1", a).map((e) => e.rowid)).toEqual([b]);
});

test("command secrets are redacted before storage", () => {
  add("x", { command: "curl -H 'Authorization: Bearer abcdef123456' https://x" });
  const row = db.query<{ command: string }, []>("SELECT command FROM events").get();
  expect(row?.command).not.toContain("abcdef123456");
});
