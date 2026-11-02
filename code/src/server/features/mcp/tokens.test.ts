import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { mintRunToken, revokeRunTokens, verifyRunToken } from "./api";

function freshDb(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return db;
}

test("minted token verifies, revoked does not, random string does not", () => {
  const db = freshDb();
  const token = mintRunToken(db, "run-1", ["report"]);
  expect(verifyRunToken(db, token)).toEqual({ runId: "run-1", scopes: ["report"] });
  expect(verifyRunToken(db, "not-a-token")).toBeNull();
  revokeRunTokens(db, "run-1");
  expect(verifyRunToken(db, token)).toBeNull();
});

test("db holds only the hash", () => {
  const db = freshDb();
  const token = mintRunToken(db, "run-2", ["report", "guard_hook"]);
  const rows = db.query("SELECT * FROM run_tokens").all();
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(rows).toHaveLength(1);
});
