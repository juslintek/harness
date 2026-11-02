import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "./db";
import { migrations } from "./migrations";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(db: ReturnType<typeof openDb>): number | undefined {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
}

test("fresh db gets all migrations and rerun is a no-op", () => {
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  expect(userVersion(db)).toBe(migrations.length);
  migrate(db, migrations);
  expect(userVersion(db)).toBe(migrations.length);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'instance'").all()).toHaveLength(1);
});

test("pragmas are applied", () => {
  const db = openDb(join(dir, "t.db"));
  expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "wal",
  );
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
});

test("a version gap throws and leaves the db untouched", () => {
  const db = openDb(join(dir, "t.db"));
  expect(() => migrate(db, [{ version: 2, sql: "CREATE TABLE x (a TEXT)" }])).toThrow(/gap/);
  expect(userVersion(db)).toBe(0);
});

test("ensureInstance creates exactly one row", () => {
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  const first = ensureInstance(db);
  expect(ensureInstance(db)).toBe(first);
  expect(db.query("SELECT id FROM instance").all()).toHaveLength(1);
});

test("a db at version 6 gains runs.pid at version 7", () => {
  const pidColumns = (db: ReturnType<typeof openDb>): number =>
    db.query("SELECT name FROM pragma_table_info('runs') WHERE name = 'pid'").all().length;
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations.slice(0, 6));
  expect(pidColumns(db)).toBe(0);
  migrate(db, migrations);
  expect(userVersion(db)).toBe(migrations.length);
  expect(pidColumns(db)).toBe(1);
});

test("a db at version 7 gains runs.pid_identity at version 8", () => {
  const columns = (db: ReturnType<typeof openDb>): number =>
    db.query("SELECT name FROM pragma_table_info('runs') WHERE name = 'pid_identity'").all().length;
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations.slice(0, 7));
  expect(columns(db)).toBe(0);
  migrate(db, migrations);
  expect(columns(db)).toBe(1);
});
