import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { partAMode } from "./gate-5-parta";
import { missingLiveEvidence, readFacts } from "./gate-5-partb";

interface Fixture {
  db: Database;
  update: (sql: string, values: unknown[]) => void;
}

function fixture(): Fixture {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT, state TEXT, org_id TEXT);
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, run_id TEXT, status TEXT, decided_by TEXT,
      created_at INTEGER, decided_at INTEGER
    );
    CREATE TABLE members (id TEXT PRIMARY KEY, org_id TEXT, kind TEXT, user_id TEXT);
    CREATE TABLE notify_targets (id TEXT PRIMARY KEY, member_id TEXT, channel TEXT, value TEXT);
    CREATE TABLE notify_log (
      id TEXT PRIMARY KEY, target_id TEXT, tag TEXT, status TEXT, at INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT, step_up_at INTEGER, revoked_at INTEGER
    );
    INSERT INTO runs VALUES ('run1', 'claude', 'completed', 'org1');
    INSERT INTO approvals VALUES ('approval1', 'run1', 'approved', 'user:user1', 100000, 120000);
    INSERT INTO members VALUES ('member1', 'org1', 'human', 'user1');
    INSERT INTO notify_targets VALUES (
      'target1', 'member1', 'push', '{"endpoint":"https://fcm.googleapis.com/fcm/send/live"}'
    );
    INSERT INTO notify_log VALUES ('delivery1', 'target1', 'approval:approval1', 'sent', 110000);
    INSERT INTO sessions VALUES ('session1', 'user1', 115000, NULL);
  `);
  return {
    db,
    update(sql, values) {
      db.query(sql).run(...(values as never[]));
    },
  };
}

const check = (db: Database, phoneObservedByOperator = false) =>
  readFacts(db, true, "approval1", "target1", phoneObservedByOperator);

test("requires a real Claude run by default and makes fake mode explicit", () => {
  expect(partAMode([])).toBe("real");
  expect(partAMode(["--real"])).toBe("real");
  expect(partAMode(["--fake"])).toBe("fake");
  expect(() => partAMode(["--fake", "--real"])).toThrow("cannot be used together");
});

test("reads approval, delivery, approver target, scoped step-up and real run from SQLite", () => {
  const { db } = fixture();
  try {
    const facts = check(db);
    expect(facts).toEqual({
      server: true,
      pushTargetForApprover: true,
      pushDelivered: true,
      approvalApproved: true,
      passkeyStepUp: true,
      claudeRunCompleted: true,
      phoneObservedByOperator: false,
    });
    expect(missingLiveEvidence(facts)).toEqual([
      "Alice has not explicitly observed phone receipt and passkey approval; after observing, rerun with --phone-observed",
    ]);
    expect(missingLiveEvidence(check(db, true))).toEqual([]);
  } finally {
    db.close();
  }
});

test("does not accept another user's or another org's push target", () => {
  const { db, update } = fixture();
  try {
    update("UPDATE members SET user_id = 'other' WHERE id = 'member1'", []);
    expect(check(db).pushTargetForApprover).toBe(false);
    update("UPDATE members SET user_id = 'user1', org_id = 'org2' WHERE id = 'member1'", []);
    expect(check(db).pushTargetForApprover).toBe(false);
    expect(check(db).pushDelivered).toBe(false);
  } finally {
    db.close();
  }
});

test("rejects insecure, loopback and test push endpoints", () => {
  const { db, update } = fixture();
  try {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/live",
      "https://127.0.0.1/push",
      "https://[::1]/push",
      "https://10.0.0.5/push",
      "https://[fe80::1]/push",
      "https://push.test/notify",
    ]) {
      update("UPDATE notify_targets SET value = ? WHERE id = 'target1'", [
        JSON.stringify({ endpoint }),
      ]);
      expect(check(db).pushTargetForApprover).toBe(false);
    }
  } finally {
    db.close();
  }
});

test("requires step-up after approval creation and within five minutes before decision", () => {
  const { db, update } = fixture();
  try {
    update("UPDATE sessions SET step_up_at = 99999 WHERE id = 'session1'", []);
    expect(check(db).passkeyStepUp).toBe(false);
    update("UPDATE sessions SET step_up_at = 115000 WHERE id = 'session1'", []);
    update("UPDATE approvals SET decided_at = 500001 WHERE id = 'approval1'", []);
    expect(check(db).passkeyStepUp).toBe(false);
    update("UPDATE approvals SET decided_at = 120000 WHERE id = 'approval1'", []);
    update("UPDATE sessions SET step_up_at = 120001 WHERE id = 'session1'", []);
    expect(check(db).passkeyStepUp).toBe(false);
  } finally {
    db.close();
  }
});

test("requires an explicit physical phone observation", () => {
  const { db } = fixture();
  try {
    expect(check(db).phoneObservedByOperator).toBe(false);
    expect(check(db, true).phoneObservedByOperator).toBe(true);
  } finally {
    db.close();
  }
});
