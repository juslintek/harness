import { afterEach, expect, setSystemTime, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  completeEnrollment,
  countUsers,
  createEnrollment,
  firstRunEnrollment,
  newRecoveryCodes,
  redeemEnrollment,
  requestEmailCode,
  useRecoveryCode,
  verifyEmailCode,
} from "./api";
import { createUser } from "./users";

afterEach(() => setSystemTime());

function setup(): { db: ReturnType<typeof openDb>; userId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return {
    db,
    userId: createUser(db, { email: "a@example.com", name: "Ada", instanceAdmin: false }),
  };
}

const MIN = 60 * 1000;

function lastCode(db: ReturnType<typeof openDb>, email = "a@example.com"): string {
  let code = "";
  requestEmailCode(db, email, (_to, value) => {
    code = value;
  });
  return code;
}

test("recovery code works once, second use null, codes from another user null", () => {
  const { db, userId } = setup();
  const other = createUser(db, { email: "b@example.com", name: "Bo", instanceAdmin: false });
  const codes = newRecoveryCodes(db, userId);
  expect(codes).toHaveLength(10);
  expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  const [first = "", second = ""] = codes;
  expect(useRecoveryCode(db, "A@example.com", first.toUpperCase())).toBe(userId);
  expect(useRecoveryCode(db, "a@example.com", first)).toBeNull();
  expect(useRecoveryCode(db, "b@example.com", second)).toBeNull();
  expect(other).not.toBe(userId);
  expect(useRecoveryCode(db, "nobody@example.com", second)).toBeNull();
});

test("a new recovery set replaces the old one", () => {
  const { db, userId } = setup();
  const [old = ""] = newRecoveryCodes(db, userId);
  newRecoveryCodes(db, userId);
  expect(useRecoveryCode(db, "a@example.com", old)).toBeNull();
});

test("email code: right code once", () => {
  const { db, userId } = setup();
  const code = lastCode(db);
  expect(code).toMatch(/^\d{6}$/);
  expect(verifyEmailCode(db, "a@example.com", code)).toBe(userId);
  expect(verifyEmailCode(db, "a@example.com", code)).toBeNull();
});

test("email code: 5 wrong attempts kill it", () => {
  const { db } = setup();
  const code = lastCode(db);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) expect(verifyEmailCode(db, "a@example.com", wrong)).toBeNull();
  expect(verifyEmailCode(db, "a@example.com", code)).toBeNull();
});

test("email code: expired after 10 min", () => {
  const { db } = setup();
  const code = lastCode(db);
  setSystemTime(new Date(Date.now() + 10 * MIN + 1));
  expect(verifyEmailCode(db, "a@example.com", code)).toBeNull();
});

test("email code: a newer request voids the older code", () => {
  const { db, userId } = setup();
  const older = lastCode(db);
  const newer = lastCode(db);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM email_codes WHERE used_at IS NULL").get()
      ?.n,
  ).toBe(1);
  const voided = db
    .query<{ used_at: number | null }, []>("SELECT used_at FROM email_codes ORDER BY rowid LIMIT 1")
    .get();
  expect(voided?.used_at).not.toBeNull();
  expect(older.length).toBe(6);
  expect(verifyEmailCode(db, "a@example.com", newer)).toBe(userId);
});

test("email code: 4th request in 15 min is rate_limited, allowed again after", () => {
  const { db } = setup();
  const send = (): string => requestEmailCode(db, "a@example.com", () => {});
  expect([send(), send(), send(), send()]).toEqual(["sent", "sent", "sent", "rate_limited"]);
  setSystemTime(new Date(Date.now() + 15 * MIN + 1));
  expect(send()).toBe("sent");
});

test("email code: unknown email delivers nothing and rate limits like a known one", () => {
  const { db } = setup();
  const delivered: string[] = [];
  const results = Array.from({ length: 4 }, () =>
    requestEmailCode(db, "ghost@example.com", (to) => delivered.push(to)),
  );
  expect(results).toEqual(["sent", "sent", "sent", "rate_limited"]);
  expect(delivered).toEqual([]);
  expect(verifyEmailCode(db, "ghost@example.com", "123456")).toBeNull();
});

test("enrollment: bootstrap creates instance admin, reuse null", () => {
  const { db } = setup();
  const empty = openDb(":memory:");
  migrate(empty, migrations);
  const code = createEnrollment(empty, { ttlMs: 10 * MIN });
  const userId = redeemEnrollment(empty, code, { email: "o@example.com", name: "Owner" });
  expect(userId).not.toBeNull();
  expect(
    empty.query<{ instance_admin: number }, []>("SELECT instance_admin FROM users").get(),
  ).toEqual({ instance_admin: 1 });
  expect(redeemEnrollment(empty, code, { email: "o2@example.com", name: "Owner" })).toBe(userId);
  completeEnrollment(empty, code);
  expect(redeemEnrollment(empty, code, { email: "o2@example.com", name: "Owner" })).toBeNull();
  expect(countUsers(empty)).toBe(1);
  createUser(db, { email: "adm@example.com", name: "Adm", instanceAdmin: true });
  const late = createEnrollment(db, { ttlMs: MIN });
  expect(redeemEnrollment(db, late, { email: "x@example.com", name: "X" })).toBeNull();
});

test("enrollment: expired null, existing-user code returns that user, email-bound code checks email", () => {
  const { db, userId } = setup();
  const stale = createEnrollment(db, { userId, ttlMs: MIN });
  setSystemTime(new Date(Date.now() + MIN + 1));
  expect(redeemEnrollment(db, stale, { email: "a@example.com", name: "Ada" })).toBeNull();
  setSystemTime();
  const mine = createEnrollment(db, { userId, ttlMs: MIN });
  expect(redeemEnrollment(db, mine, { email: "a@example.com", name: "Ada" })).toBe(userId);
  const invite = createEnrollment(db, { email: "new@example.com", ttlMs: MIN });
  expect(redeemEnrollment(db, invite, { email: "other@example.com", name: "N" })).toBeNull();
  const joined = redeemEnrollment(db, invite, { email: "new@example.com", name: "New" });
  expect(joined).not.toBeNull();
  expect(
    db
      .query<{ instance_admin: number }, [string]>("SELECT instance_admin FROM users WHERE id = ?")
      .get(joined ?? ""),
  ).toEqual({ instance_admin: 0 });
});

test("first run: one live bootstrap link, and a bootstrap that never got a passkey is offered again", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const profile = { email: "o@example.com", name: "Owner" };
  const first = firstRunEnrollment(db, MIN) ?? "";
  const second = firstRunEnrollment(db, MIN) ?? "";
  expect(redeemEnrollment(db, first, profile)).toBeNull();
  const userId = redeemEnrollment(db, second, profile) ?? "";
  expect(userId).not.toBe("");
  const again = firstRunEnrollment(db, MIN) ?? "";
  expect(redeemEnrollment(db, second, profile)).toBeNull();
  expect(redeemEnrollment(db, again, profile)).toBe(userId);
  db.run(
    "INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES ('p', ?, x'00', 0, 'k', 1)",
    [userId],
  );
  expect(firstRunEnrollment(db, MIN)).toBeNull();
});

const addPasskey = (db: ReturnType<typeof openDb>, userId: string): void => {
  db.run(
    "INSERT INTO passkeys (id, user_id, public_key, counter, name, created_at) VALUES (?, ?, x'00', 0, 'k', 1)",
    [Bun.randomUUIDv7(), userId],
  );
};

test("a regular user with a passkey does not close first run; the link makes a new admin", () => {
  const { db, userId } = setup();
  addPasskey(db, userId);
  const code = firstRunEnrollment(db, MIN);
  expect(code).not.toBeNull();
  const adminId = redeemEnrollment(db, code ?? "", { email: "boss@example.com", name: "Boss" });
  expect(adminId).not.toBeNull();
  expect(adminId).not.toBe(userId);
  const flags = db
    .query<{ id: string; instance_admin: number }, []>("SELECT id, instance_admin FROM users")
    .all();
  expect(flags.find((u) => u.id === userId)?.instance_admin).toBe(0);
  expect(flags.find((u) => u.id === adminId)?.instance_admin).toBe(1);
});

test("an admin without a passkey gets a link for their own account, one with a passkey gets none", () => {
  const { db, userId } = setup();
  addPasskey(db, userId);
  const adminId = createUser(db, { email: "boss@example.com", name: "Boss", instanceAdmin: true });
  const code = firstRunEnrollment(db, MIN) ?? "";
  expect(redeemEnrollment(db, code, { email: "x@example.com", name: "X" })).toBe(adminId);
  addPasskey(db, adminId);
  expect(firstRunEnrollment(db, MIN)).toBeNull();
});

test("first run: mobile enrollment bootstrap prevents re-minting admin enrollment code", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const code = firstRunEnrollment(db, MIN) ?? "";
  const adminId = redeemEnrollment(db, code, { email: "owner@example.com", name: "Owner" }) ?? "";
  completeEnrollment(db, code);

  const sessionId = "s_mob_1";
  const now = Date.now();
  db.run(
    "INSERT INTO sessions (id, user_id, token_hash, method, created_at, last_seen_at, expires_at) VALUES (?, ?, 'th', 'mobile', ?, ?, ?)",
    [sessionId, adminId, now, now, now + 30 * 24 * 3600 * 1000],
  );
  db.run(
    "INSERT INTO mobile_devices (id, user_id, session_id, name, platform, public_key_spki, created_at, last_used_at) VALUES ('md1', ?, ?, 'iPhone', 'ios', 'spki', ?, ?)",
    [adminId, sessionId, now, now],
  );

  expect(firstRunEnrollment(db, MIN)).toBeNull();
});
