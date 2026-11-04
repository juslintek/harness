// Rows are written into harness.db before the server opens it. The schema comes from the migration
// files themselves, which both servers must accept unchanged as an existing database.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../src/server/db/migrations");
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeededSession {
  userId: string;
  sessionId: string;
  token: string;
  cookie: string;
}

export interface SeedOpts {
  admin?: boolean;
  stepUp?: boolean;
  expired?: boolean;
  revoked?: boolean;
}

function migrationFiles(): { version: number; file: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .flatMap((file) => {
      const match = MIGRATION_FILE.exec(file);
      return match?.[1] ? [{ version: Number(match[1]), file }] : [];
    })
    .sort((a, b) => a.version - b.version);
}

export function latestMigration(): number {
  return migrationFiles().at(-1)?.version ?? 0;
}

export function openSeedDb(path: string): Database {
  return new Database(path, { create: true, strict: true });
}

export function applyMigrations(db: Database): void {
  for (const { version, file } of migrationFiles()) {
    db.transaction(() => {
      db.run(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      db.run(`PRAGMA user_version = ${version}`);
    })();
  }
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// The same two rows a passkey login leaves behind, minus the ceremony.
export function seedSession(db: Database, opts: SeedOpts = {}): SeededSession {
  const now = Date.now();
  const userId = Bun.randomUUIDv7();
  const sessionId = Bun.randomUUIDv7();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, 'Test', ?, ?)",
  ).run(userId, `${userId}@example.test`, opts.admin ? 1 : 0, now);
  db.query(
    `INSERT INTO sessions
       (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at, revoked_at)
     VALUES (?, ?, ?, 'passkey', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    sha256Hex(token),
    now,
    now,
    now + (opts.expired ? -DAY_MS : 30 * DAY_MS),
    opts.stepUp ? now : null,
    opts.revoked ? now : null,
  );
  return { userId, sessionId, token, cookie: `harness_session=${token}` };
}
