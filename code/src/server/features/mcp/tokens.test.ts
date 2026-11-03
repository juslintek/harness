import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createOrg } from "../orgs/api";
import { mintRunToken, revokeRunTokens, verifyRunToken } from "./api";

function freshDb(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return db;
}

test("minted token verifies, revoked does not, random string does not", () => {
  const db = freshDb();
  const token = mintRunToken(db, "run-1", ["report"]);
  expect(verifyRunToken(db, token)).toEqual({
    runId: "run-1",
    scopes: ["report"],
    memberId: null,
    orgId: null,
    candidateId: null,
  });
  expect(verifyRunToken(db, "not-a-token")).toBeNull();
  revokeRunTokens(db, "run-1");
  expect(verifyRunToken(db, token)).toBeNull();
});

test("revoking deletes the rows of that run only", () => {
  const db = freshDb();
  mintRunToken(db, "run-3", ["report"]);
  mintRunToken(db, "run-3", ["guard_hook"]);
  const other = mintRunToken(db, "run-4", ["report"]);
  revokeRunTokens(db, "run-3");
  expect(db.query("SELECT run_id FROM run_tokens").all()).toEqual([{ run_id: "run-4" }]);
  expect(verifyRunToken(db, other)).not.toBeNull();
});

test("db holds only the hash", () => {
  const db = freshDb();
  const token = mintRunToken(db, "run-2", ["report", "guard_hook"]);
  const rows = db.query("SELECT * FROM run_tokens").all();
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(rows).toHaveLength(1);
});

test("a token cannot bind a member to an org it does not belong to", () => {
  const db = freshDb();
  const mk = (slug: string) =>
    createOrg(db, { name: slug, slug, ownerUserId: slug, ownerName: slug, ownerHandle: slug });
  const [a, b] = [mk("acme"), mk("beta")];
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(a.id);
  expect(() =>
    mintRunToken(db, "r", ["board"], { memberId: owner?.id ?? "", orgId: b.id }),
  ).toThrow();
  expect(() => mintRunToken(db, "r", ["board"], { memberId: "ghost", orgId: a.id })).toThrow();
});
