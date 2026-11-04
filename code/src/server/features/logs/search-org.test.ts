import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { appendEvent, type EventKind } from "./api";
import { searchOrgEvents } from "./search-org";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-logs-org-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  for (const org of ["A", "B"]) {
    db.run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, 1)", [
      org,
      org.toLowerCase(),
      org,
    ]);
    db.run(
      `INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at)
       VALUES (?, ?, 'agent', 'claude', ?, ?, 'member', 1)`,
      [`m${org}`, org, `bot-${org}`, `bot-${org}`],
    );
    db.run(
      `INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id, org_id)
       VALUES (?, 'claude', '/r', 'p', 'completed', 1, ?, ?)`,
      [`run${org}`, `m${org}`, org],
    );
  }
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('admin-u', 'A', 'human', 'u', 'admin-u', 'admin-u', 'admin', 1)`,
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function add(
  runId: string | undefined,
  body: string,
  ts: number,
  kind: EventKind = "message",
): void {
  appendEvent(db, { kind, body, ts, ...(runId && { runId }) });
}

test("an org B run's events never appear in org A results, and runless events are excluded", () => {
  add("runA", "deploy alpha", 10);
  add("runB", "deploy beta", 11);
  add(undefined, "deploy orphan", 12);
  const hits = searchOrgEvents(db, "A", { userId: "u", text: "deploy" });
  expect(hits.map((h) => h.snippet)).toEqual(["deploy alpha"]);
  expect(hits[0]).toMatchObject({ memberHandle: "bot-A", runId: "runA", taskId: null });
});

test("kind and member filters narrow the results", () => {
  add("runA", "deploy one", 10, "message");
  add("runA", "deploy two", 11, "error");
  expect(
    searchOrgEvents(db, "A", { userId: "u", text: "deploy", kind: "error" }).map((h) => h.ts),
  ).toEqual([11]);
  expect(searchOrgEvents(db, "A", { userId: "u", text: "deploy", memberId: "mB" })).toEqual([]);
  expect(searchOrgEvents(db, "A", { userId: "u", text: "deploy", memberId: "mA" })).toHaveLength(2);
});

test("the before cursor returns the next page without overlap", () => {
  for (let i = 1; i <= 5; i++) add("runA", `deploy ${i}`, i * 10);
  const first = searchOrgEvents(db, "A", { userId: "u", text: "deploy", limit: 2 });
  const last = first.at(-1);
  if (!last) throw new Error("empty page");
  const second = searchOrgEvents(db, "A", {
    userId: "u",
    text: "deploy",
    limit: 2,
    before: last.ts,
  });
  expect(first.map((h) => h.ts)).toEqual([50, 40]);
  expect(second.map((h) => h.ts)).toEqual([30, 20]);
});

test("quotes and wildcards in the text do not throw", () => {
  add("runA", 'say "hi" now', 10);
  for (const text of ['"', 'say "hi', "*", "dep*", "a AND", "(", "-"]) {
    expect(() => searchOrgEvents(db, "A", { userId: "u", text })).not.toThrow();
  }
  expect(searchOrgEvents(db, "A", { userId: "u", text: '"hi"' })).toHaveLength(1);
});

test("events sharing a millisecond page through with a (ts, rowid) cursor", () => {
  for (let i = 0; i < 5; i++) add("runA", `deploy same ${i}`, 10);
  const seen: number[] = [];
  let cursor: { before?: number; beforeRowid?: number } = {};
  for (let page = 0; page < 5; page++) {
    const hits = searchOrgEvents(db, "A", { userId: "u", text: "deploy", limit: 2, ...cursor });
    seen.push(...hits.map((h) => h.rowid));
    const last = hits.at(-1);
    if (!last) break;
    cursor = { before: last.ts, beforeRowid: last.rowid };
  }
  expect(seen).toHaveLength(5);
  expect(new Set(seen).size).toBe(5);
});

test("another org's matches cannot crowd this org's hit out of the candidate cap", () => {
  add("runA", "deploy ".concat("filler ".repeat(30)), 1);
  for (let i = 0; i < 6; i++) add("runB", "deploy", 10 + i);
  const hits = searchOrgEvents(db, "A", { userId: "u", text: "deploy" }, 3);
  expect(hits.map((h) => h.ts)).toEqual([1]);
});

test("a run in a project the user cannot open is hidden until the org is granted access", () => {
  db.run("INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('P', 'B', 'P', 'P', 1)");
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('hu', 'A', 'human', 'u1', 'hu', 'hu', 'member', 1)`,
  );
  db.run("UPDATE runs SET project_id = 'P' WHERE id = 'runA'");
  add("runA", "deploy secret", 10);
  expect(searchOrgEvents(db, "A", { userId: "u1", text: "deploy" })).toEqual([]);
  db.run(
    "INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES ('g', 'P', 'A', 'read', 'x', 1)",
  );
  expect(searchOrgEvents(db, "A", { userId: "u1", text: "deploy" })).toHaveLength(1);
});

test("a removed member's run stays searchable in its project's org and never shows in another", () => {
  for (const [id, org] of [
    ["PA", "A"],
    ["PB", "B"],
  ] as const) {
    db.run("INSERT INTO projects (id, org_id, key, name, created_at) VALUES (?, ?, ?, ?, 1)", [
      id,
      org,
      id,
      id,
    ]);
  }
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('hu', 'A', 'human', 'u1', 'hu', 'hu', 'owner', 1)`,
  );
  db.run("UPDATE runs SET project_id = 'PA' WHERE id = 'runA'");
  db.run("UPDATE runs SET project_id = 'PB' WHERE id = 'runB'");
  add("runA", "deploy alpha", 10);
  add("runB", "deploy beta", 11);
  db.run("DELETE FROM members WHERE id IN ('mA', 'mB')");
  const inA = searchOrgEvents(db, "A", { userId: "u1", text: "deploy" });
  expect(inA.map((h) => [h.snippet, h.memberHandle])).toEqual([["deploy alpha", "(removed)"]]);
  expect(searchOrgEvents(db, "B", { userId: "u1", text: "deploy" })).toEqual([]);
});

test("the candidate cap keeps the newest matches even when older ones rank higher", () => {
  add("runA", "deploy", 1);
  add("runA", "deploy", 2);
  add("runA", "deploy", 3);
  for (let i = 0; i < 3; i++) add("runA", `deploy ${"filler ".repeat(20)}${i}`, 100 + i);
  const hits = searchOrgEvents(db, "A", { userId: "u", text: "deploy" }, 3);
  expect(hits.map((h) => h.ts)).toEqual([102, 101, 100]);
});

function grantee(): void {
  db.run("INSERT INTO projects (id, org_id, key, name, created_at) VALUES ('P', 'B', 'P', 'P', 1)");
  db.run(
    "INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES ('g', 'P', 'A', 'write', 'x', 1)",
  );
  db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('hu', 'A', 'human', 'u1', 'hu', 'hu', 'owner', 1), ('hb', 'B', 'human', 'u2', 'hb', 'hb', 'owner', 1)`,
  );
}

test("a grantee org's run on the owner org's project stays in the grantee org after member removal", () => {
  grantee();
  db.run("UPDATE runs SET project_id = 'P', org_id = 'A' WHERE id = 'runA'");
  add("runA", "deploy alpha", 10);
  db.run("DELETE FROM members WHERE id = 'mA'");
  expect(searchOrgEvents(db, "A", { userId: "u1", text: "deploy" })).toHaveLength(1);
  expect(searchOrgEvents(db, "B", { userId: "u2", text: "deploy" })).toEqual([]);
});

test("a run with no project is hidden from a member and shown to an admin", () => {
  for (const [id, user, role] of [
    ["hm", "u3", "member"],
    ["ha", "u4", "admin"],
  ] as const) {
    db.run(
      `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
       VALUES (?, 'A', 'human', ?, ?, ?, ?, 1)`,
      [id, user, id, id, role],
    );
  }
  add("runA", "deploy dm", 10);
  expect(searchOrgEvents(db, "A", { userId: "u3", text: "deploy" })).toEqual([]);
  expect(searchOrgEvents(db, "A", { userId: "u4", text: "deploy" })).toHaveLength(1);
});
