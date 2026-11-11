import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export interface Migration {
  version: number;
  sql: string;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  return db;
}

function currentVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export function migrate(db: Database, migrations: readonly Migration[]): void {
  let version = currentVersion(db);
  const known = migrations.at(-1)?.version ?? 0;
  // An older build must not run against a schema it does not know, and never moves user_version down.
  if (version > known) {
    throw new Error(`Database is at schema ${version}, this build only knows up to ${known}`);
  }
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) {
      throw new Error(`Migration gap: database is at ${version}, next is ${migration.version}`);
    }
    // user_version is part of the same transaction, so a failed migration leaves it untouched.
    db.transaction(() => {
      db.run(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
}

export function ensureInstance(db: Database): string {
  const existing = db.query<{ id: string }, []>("SELECT id FROM instance LIMIT 1").get();
  if (existing) return existing.id;
  const id = Bun.randomUUIDv7();
  db.run("INSERT INTO instance (id, created_at) VALUES (?, ?)", [id, Date.now()]);
  return id;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// The home can be shared with other accounts, so a lock or mutex path that is a symlink (or
// anything but a regular file) is refused, never followed: writing through it could truncate or
// create a file outside the home.
function refuseNonRegular(path: string): void {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!isFile) throw new Error(`${path} is not a regular file, remove it`);
}

// Content that is not a positive pid counts as stale: kill(0) would signal our own process group
// and kill(-n) a whole group, so they must never reach the liveness check.
export function lockPid(path: string): number | null {
  refuseNonRegular(path);
  let text: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try {
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const pid = /^\d+\s*$/.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

// Written to a private file and renamed over the lock, so a symlink at the lock path is replaced
// rather than written through, and the lock never exists half written.
function writeLock(path: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(
    tmp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Every look at the lock file and every write of it happens while holding harness.lock.takeover,
// an O_EXCL file that exists only for those few calls. A path has no compare-and-swap, so without
// the mutex two servers that read the same dead pid could each replace the lock, or one could
// remove a lock another had just created. A mutex left behind by a crash inside this window is
// not guessed at: the caller is told to remove it.
function withTakeover<T>(path: string, fn: () => T): T {
  const mutex = `${path}.takeover`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      closeSync(openSync(mutex, "wx"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      refuseNonRegular(mutex);
      sleepMs(20);
      continue;
    }
    try {
      return fn();
    } finally {
      rmSync(mutex, { force: true });
    }
  }
  throw new Error(`Could not lock: ${mutex} is held, remove it if no server is starting`);
}

// SQLite's own locks would let two servers share one home and race on worktrees and the run
// scratch dir, so the home gets a pid file. A file left by a dead process, or with junk in it, is
// overwritten.
export function lockHome(home: string): () => void {
  const path = join(home, "harness.lock");
  withTakeover(path, () => {
    const pid = lockPid(path);
    if (pid !== null && pidAlive(pid)) {
      throw new Error(`Another harness server (pid ${pid}) is already using ${home}`);
    }
    writeLock(path);
  });
  // Idempotent, and it only removes a lock that still holds our pid: after a release another
  // server may own the file, and a late exit handler must not delete its lock.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try {
      if (lockPid(path) === process.pid) rmSync(path, { force: true });
    } catch {
      // a lock that is not a readable regular file is not ours to remove
    }
  };
  process.on("exit", release);
  return release;
}
