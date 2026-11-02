import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { decideApproval, expireApprovals, listApprovals } from "./api";

let dir: string;
let db: Database;

function insert(id: string, expiresAt: number, status = "pending"): void {
  db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES (?, 'r', '{}', '{}', ?, 1, ?)",
    [id, status, expiresAt],
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-approvals-"));
  db = openDb(join(dir, "t.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("decide twice: only the first wins", () => {
  insert("a", Date.now() + 60_000);
  expect(decideApproval(db, "a", "deny", "x")).toBe(true);
  expect(decideApproval(db, "a", "approve", "y")).toBe(false);
  expect(listApprovals(db)[0]).toMatchObject({ status: "denied", decidedBy: "x" });
});

test("decide past expiry fails and marks the row expired", () => {
  insert("a", Date.now() - 1);
  expect(decideApproval(db, "a", "approve", "x")).toBe(false);
  expect(listApprovals(db)[0]?.status).toBe("expired");
});

test("decide on an unknown id is false", () => {
  expect(decideApproval(db, "nope", "approve", "x")).toBe(false);
});

test("expireApprovals only touches pending rows past expiry", () => {
  insert("old", 10);
  insert("fresh", 1000);
  insert("done", 10, "approved");
  expect(expireApprovals(db, 500)).toBe(1);
  expect(listApprovals(db, "expired").map((a) => a.id)).toEqual(["old"]);
  expect(listApprovals(db, "pending").map((a) => a.id)).toEqual(["fresh"]);
});
