import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// VACUUM INTO gives a consistent copy while the server keeps writing; copying the file would not.
export function snapshotDb(db: Database, home: string, name: string): string {
  const dir = join(home, "snapshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.db`);
  rmSync(file, { force: true });
  db.query("VACUUM INTO ?").run(file);
  return file;
}

export function copyToScratch(snapshot: string, scratchHome: string): void {
  mkdirSync(scratchHome, { recursive: true });
  copyFileSync(snapshot, join(scratchHome, "harness.db"));
}

// A stale -wal would replay old frames onto the restored file, so both side files go first.
export function restoreSnapshot(home: string, snapshot: string): void {
  const live = join(home, "harness.db");
  rmSync(`${live}-wal`, { force: true });
  rmSync(`${live}-shm`, { force: true });
  // Same directory, so the rename is atomic and a kill mid-copy cannot leave a torn db.
  const staged = `${live}.restore`;
  copyFileSync(snapshot, staged);
  renameSync(staged, live);
}
