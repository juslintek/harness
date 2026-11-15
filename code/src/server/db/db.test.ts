import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, lockHome, migrate, openDb } from "./db";
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

test("migration 040 preserves existing oauth_consent_challenges rows across sessions rebuild", () => {
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations.slice(0, 38));
  db.run(
    "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('u1', 'u@test', 'U', 1, 1)",
  );
  db.run(
    "INSERT INTO sessions (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at) VALUES ('s1', 'u1', 'th', 'passkey', 'ua', 1, 1, 100000)",
  );
  db.run(
    "INSERT INTO oauth_consent_challenges (challenge_id, session_id, user_id, grant_hash, expires_at) VALUES ('c1', 's1', 'u1', 'gh', 100000)",
  );
  migrate(db, migrations);
  const row = db
    .query("SELECT challenge_id FROM oauth_consent_challenges WHERE challenge_id = 'c1'")
    .get();
  expect(row).toEqual({ challenge_id: "c1" });
});

test("a db with a newer user_version than the known migrations is refused and left alone", () => {
  const db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
  db.run(`PRAGMA user_version = ${migrations.length + 1}`);
  expect(() => migrate(db, migrations)).toThrow(/only knows up to/);
  expect(userVersion(db)).toBe(migrations.length + 1);
});

test("a second lock on the same home is refused until the first is released", () => {
  const release = lockHome(dir);
  expect(() => lockHome(dir)).toThrow(/already using/);
  release();
  lockHome(dir)();
});

test("a lock file left by a dead process is taken over", () => {
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(dir, "harness.lock"), `${dead}\n`);
  const release = lockHome(dir);
  expect(readFileSync(join(dir, "harness.lock"), "utf8")).toBe(`${process.pid}\n`);
  release();
});

test("a lock file with unparsable content counts as stale", () => {
  writeFileSync(join(dir, "harness.lock"), "garbage");
  lockHome(dir)();
});

test("pid 0, a negative pid and other junk are stale, not signalled", () => {
  for (const content of ["0\n", "-1\n", "NaN", "1e3x", ""]) {
    writeFileSync(join(dir, "harness.lock"), content);
    const release = lockHome(dir);
    expect(readFileSync(join(dir, "harness.lock"), "utf8")).toBe(`${process.pid}\n`);
    release();
  }
});

test("servers racing to take over one stale lock end with exactly one owner", async () => {
  writeFileSync(join(dir, "harness.lock"), `${Bun.spawnSync(["true"]).pid}\n`);
  const code = `
    import { lockHome } from ${JSON.stringify(join(import.meta.dir, "db"))};
    try { lockHome(process.argv[1]); console.log("ok"); } catch { console.log("refused"); }
    await new Promise((done) => process.stdin.on("end", done).resume());
  `;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn(["bun", "-e", code, dir], { stdin: "pipe", stdout: "pipe" }),
  );
  try {
    const results = await Promise.all(
      children.map(async (child) => await new Response(child.stdout).body?.getReader().read()),
    );
    const lines = results.map((r) => new TextDecoder().decode(r?.value).trim());
    expect(lines.filter((line) => line === "ok")).toHaveLength(1);
    const owner = Number.parseInt(readFileSync(join(dir, "harness.lock"), "utf8"), 10);
    expect(children.map((child) => child.pid)).toContain(owner);
  } finally {
    for (const child of children) {
      child.stdin.end();
      await child.exited;
    }
  }
});

test("a lock or takeover file that is a symlink is refused and its target left alone", () => {
  const outside = mkdtempSync(join(tmpdir(), "harness-outside-"));
  const target = join(outside, "target");
  try {
    for (const name of ["harness.lock", "harness.lock.takeover"]) {
      writeFileSync(target, "untouched");
      symlinkSync(target, join(dir, name));
      expect(() => lockHome(dir)).toThrow(/not a regular file/);
      expect(readFileSync(target, "utf8")).toBe("untouched");
      rmSync(join(dir, name));
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release is idempotent, drops its exit listener and never removes another owner's lock", () => {
  const listeners = process.listenerCount("exit");
  const release = lockHome(dir);
  expect(process.listenerCount("exit")).toBe(listeners + 1);
  release();
  expect(process.listenerCount("exit")).toBe(listeners);
  expect(existsSync(join(dir, "harness.lock"))).toBe(false);
  // Another server (here: our parent, a live pid that is not ours) now owns the home.
  writeFileSync(join(dir, "harness.lock"), `${process.ppid}\n`);
  release();
  expect(readFileSync(join(dir, "harness.lock"), "utf8")).toBe(`${process.ppid}\n`);
});
