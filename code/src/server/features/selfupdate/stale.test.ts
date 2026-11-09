import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeHome } from "../../test-support/selfupdate-kit";
import {
  createIfIdle,
  createRequest,
  getRequest,
  hasBusyRequest,
  SWAP_BUSY_MS,
  setStatus,
} from "./requests";
import { failStaleSwaps } from "./stale";
import { swapPidFile } from "./swap";

const input = { repo: "r", branch: "b", commitSha: "c", createdBy: "u" };

function swappingRow(db: ReturnType<typeof makeHome>["db"], ageMs = 0): string {
  const id = createRequest(db, input).id;
  setStatus(db, id, "swapping");
  db.query("UPDATE update_requests SET swapping_at = ? WHERE id = ?").run(Date.now() - ageMs, id);
  return id;
}

function writePid(home: string, id: string, pid: number): void {
  const file = swapPidFile(home, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${pid}`);
}

test("a swapping row older than 15 minutes no longer blocks a new request", () => {
  const { db } = makeHome();
  swappingRow(db, SWAP_BUSY_MS + 1000);
  expect(hasBusyRequest(db)).toBe(false);
  expect(createIfIdle(db, input)).not.toBeNull();
});

test("a fresh swapping row blocks, and only one of two creates wins", () => {
  const { db } = makeHome();
  swappingRow(db);
  expect(hasBusyRequest(db)).toBe(true);
  expect(createIfIdle(db, input)).toBeNull();
});

test("boot fails a swapping row with no live swap process", () => {
  const { db, home } = makeHome();
  const missing = swappingRow(db);
  const dead = swappingRow(db);
  writePid(home, dead, 2 ** 22 + 1);
  const alive = swappingRow(db);
  writePid(home, alive, process.pid);
  failStaleSwaps(db, home);
  expect(getRequest(db, missing)).toMatchObject({ status: "failed", reason: "swap_interrupted" });
  expect(getRequest(db, dead)).toMatchObject({ status: "failed", reason: "swap_interrupted" });
  expect(getRequest(db, alive)?.status).toBe("swapping");
});
