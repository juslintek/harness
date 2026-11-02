import { Database } from "bun:sqlite";

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
