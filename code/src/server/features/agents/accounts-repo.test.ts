import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createAccount, markRemoved, updateAccount } from "./accounts-repo";
import { ensureDefaultAccount, getAccount, listAccounts, setLinked } from "./api";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-accounts-"));
  db = openDb(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedAt38(): void {
  migrate(db, migrations.slice(0, 38));
  db.run(
    "INSERT INTO agent_links (agent_id, enabled, updated_at) VALUES ('claude', 1, 1), ('codex', 1, 1)",
  );
  for (const [id, agent] of [
    ["r1", "claude"],
    ["r2", "codex"],
    ["r3", "ghost"],
  ] as const) {
    db.run(
      "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, '/r', 'p', 'completed', 1)",
      [id, agent],
    );
  }
  for (const provider of ["claude", "codex", "weird"]) {
    db.run(
      "INSERT INTO quota_snapshots (id, provider, window, source, ts) VALUES (?, ?, 'five_hour', 'test', 1)",
      [`q-${provider}`, provider],
    );
  }
  db.run("INSERT INTO events (id, ts, agent, kind) VALUES ('e1', 1, 'claude', 'run.started')");
}

function column(sql: string, ...args: string[]): Array<Record<string, unknown>> {
  return db.query<Record<string, unknown>, string[]>(sql).all(...args);
}

test("migration 039 creates a default account per known runtime and backfills the columns", () => {
  seedAt38();
  migrate(db, migrations);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
  const accounts = column(
    "SELECT id, kind, label, home, state, max_concurrent FROM agent_accounts ORDER BY id",
  );
  expect(accounts.map((a) => a.id)).toEqual(["default:claude", "default:codex", "default:ghost"]);
  expect(
    accounts.every((a) => a.home === null && a.kind === "login" && a.state === "unknown"),
  ).toBe(true);
  expect(accounts.map((a) => a.max_concurrent)).toEqual([2, 1, 2]);
  expect(column("SELECT id, account_id FROM runs ORDER BY id")).toEqual([
    { id: "r1", account_id: "default:claude" },
    { id: "r2", account_id: "default:codex" },
    { id: "r3", account_id: "default:ghost" },
  ]);
  expect(column("SELECT id, account_id FROM quota_snapshots ORDER BY id")).toEqual([
    { id: "q-claude", account_id: "default:claude" },
    { id: "q-codex", account_id: "default:codex" },
    { id: "q-weird", account_id: null },
  ]);
  expect(column("SELECT id, account_id FROM events")).toEqual([{ id: "e1", account_id: null }]);
});

test("events.account_id cannot change after insert", () => {
  seedAt38();
  migrate(db, migrations);
  expect(() => db.run("UPDATE events SET account_id = 'default:claude' WHERE id = 'e1'")).toThrow(
    /append-only/,
  );
  expect(() => db.run("UPDATE events SET kind = 'x' WHERE id = 'e1'")).toThrow(/append-only/);
});

test("running the migrations again changes nothing", () => {
  seedAt38();
  migrate(db, migrations);
  const before = column("SELECT * FROM agent_accounts ORDER BY id");
  migrate(db, migrations);
  expect(column("SELECT * FROM agent_accounts ORDER BY id")).toEqual(before);
});

test("a fresh database starts with no accounts", () => {
  migrate(db, migrations);
  expect(listAccounts(db)).toEqual([]);
});

test("ensureDefaultAccount is idempotent and keeps edits", () => {
  migrate(db, migrations);
  const first = ensureDefaultAccount(db, "claude");
  updateAccount(db, first.id, { priority: 5 });
  const second = ensureDefaultAccount(db, "claude");
  expect(second.id).toBe("default:claude");
  expect(second.priority).toBe(5);
  expect(listAccounts(db, "claude")).toHaveLength(1);
  expect(ensureDefaultAccount(db, "codex").maxConcurrent).toBe(1);
});

test("setLinked creates the default account for a newly linked runtime", () => {
  migrate(db, migrations);
  setLinked(db, "agy", false);
  expect(listAccounts(db)).toEqual([]);
  setLinked(db, "agy", true);
  setLinked(db, "agy", false);
  expect(getAccount(db, "default:agy")?.runtime).toBe("agy");
  expect(listAccounts(db)).toHaveLength(1);
});

test("createAccount, updateAccount and markRemoved keep the row", () => {
  migrate(db, migrations);
  const made = createAccount(db, { runtime: "claude", kind: "login", label: "work", home: "/h/a" });
  expect(made.state).toBe("pending");
  expect(made.maxConcurrent).toBe(2);
  expect(
    createAccount(db, { runtime: "codex", kind: "login", label: "b", home: "/h/b" }).maxConcurrent,
  ).toBe(1);
  expect(() =>
    createAccount(db, { runtime: "claude", kind: "login", label: "work", home: null }),
  ).toThrow();
  expect(updateAccount(db, made.id, { state: "active", label: "work2" })?.label).toBe("work2");
  expect(markRemoved(db, made.id)?.state).toBe("removed");
  expect(getAccount(db, made.id)?.home).toBe("/h/a");
  expect(getAccount(db, "nope")).toBeNull();
});
