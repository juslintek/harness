import { afterEach, expect, setSystemTime, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  createSession,
  findUserByEmail,
  getUser,
  hasFreshStepUp,
  listSessions,
  revokeSession,
  type Session,
  type SessionInfo,
  sessionFromToken,
  type User,
} from "./api";
import { createMobileSession, insertMobileDevice, listMobileDevices } from "./mobile-devices";
import { createUser } from "./users";

afterEach(() => setSystemTime());

function live(db: ReturnType<typeof openDb>, token: string): Session {
  const session = sessionFromToken(db, token);
  if (!session) throw new Error("no session");
  return session;
}

function setup(): { db: ReturnType<typeof openDb>; userId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return {
    db,
    userId: createUser(db, { email: "a@example.com", name: "Ada", instanceAdmin: true }),
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function expiry(db: ReturnType<typeof openDb>, id: string): number {
  return (
    db.query<{ e: number }, [string]>("SELECT expires_at AS e FROM sessions WHERE id = ?").get(id)
      ?.e ?? 0
  );
}

test("token resolves to a session carrying the admin flag; unknown token is null", () => {
  const { db, userId } = setup();
  const { token, id } = createSession(db, userId, "passkey", "ua");
  expect(sessionFromToken(db, token)).toEqual({
    id,
    userId,
    method: "passkey",
    stepUpAt: null,
    instanceAdmin: true,
  });
  expect(sessionFromToken(db, "nope")).toBeNull();
  const stored = db.query<{ token_hash: string }, []>("SELECT token_hash FROM sessions").get();
  expect(stored?.token_hash).not.toBe(token);
});

test("recovery and enroll sessions start with step-up, email ones never do", () => {
  const { db, userId } = setup();
  for (const method of ["recovery", "enroll"] as const) {
    const { token } = createSession(db, userId, method, null);
    expect(hasFreshStepUp(live(db, token))).toBe(true);
  }
  const { token } = createSession(db, userId, "email", null);
  expect(sessionFromToken(db, token)?.stepUpAt).toBeNull();
});

test("revoked or expired session token returns null", () => {
  const { db, userId } = setup();
  const revoked = createSession(db, userId, "passkey", null);
  expect(revokeSession(db, userId, revoked.id)).toBe(true);
  expect(revokeSession(db, userId, revoked.id)).toBe(false);
  expect(sessionFromToken(db, revoked.token)).toBeNull();
  const aging = createSession(db, userId, "passkey", null);
  setSystemTime(new Date(Date.now() + 31 * DAY));
  expect(sessionFromToken(db, aging.token)).toBeNull();
});

test("another user cannot revoke a session", () => {
  const { db, userId } = setup();
  const other = createUser(db, { email: "b@example.com", name: "Bo", instanceAdmin: false });
  const { id, token } = createSession(db, userId, "passkey", null);
  expect(revokeSession(db, other, id)).toBe(false);
  expect(sessionFromToken(db, token)).not.toBeNull();
  expect(listSessions(db, other)).toEqual([]);
});

test("session sliding updates expires_at at most hourly", () => {
  const { db, userId } = setup();
  const { id, token } = createSession(db, userId, "passkey", null);
  const start = Date.now();
  const first = expiry(db, id);
  setSystemTime(new Date(start + 30 * 60 * 1000));
  sessionFromToken(db, token);
  expect(expiry(db, id)).toBe(first);
  setSystemTime(new Date(start + HOUR + 1));
  sessionFromToken(db, token);
  expect(expiry(db, id)).toBe(start + HOUR + 1 + 30 * DAY);
  setSystemTime(new Date(start + HOUR + 1 + 30 * 60 * 1000));
  sessionFromToken(db, token);
  expect(expiry(db, id)).toBe(start + HOUR + 1 + 30 * DAY);
});

test("listSessions shows live sessions only", () => {
  const { db, userId } = setup();
  const a = createSession(db, userId, "passkey", "Safari");
  const b = createSession(db, userId, "email", null);
  revokeSession(db, userId, b.id);
  const rows: SessionInfo[] = listSessions(db, userId);
  expect(rows.map((row) => row.id)).toEqual([a.id]);
  expect(rows[0]?.userAgent).toBe("Safari");
});

test("users are found by id and by email ignoring case", () => {
  const { db, userId } = setup();
  const user: User | null = getUser(db, userId);
  expect(user).toMatchObject({ email: "a@example.com", name: "Ada", instanceAdmin: true });
  expect(findUserByEmail(db, "A@EXAMPLE.COM")?.id).toBe(userId);
  expect(findUserByEmail(db, "x@example.com")).toBeNull();
  expect(getUser(db, "missing")).toBeNull();
});

test("cookie session lookup refuses mobile session tokens", () => {
  const { db, userId } = setup();
  const mobToken = "hmob_0123456789abcdef0123456789abcdef0123456789";
  const { id: sessionId } = createMobileSession(db, userId, mobToken, null);
  insertMobileDevice(db, {
    userId,
    sessionId,
    name: "Phone",
    platform: "ios",
    publicKeySpki: "spki",
  });
  expect(sessionFromToken(db, mobToken)).toBeNull();
});

test("listMobileDevices excludes revoked or expired sessions", () => {
  const { db, userId } = setup();
  const t1 = "hmob_111111111111111111111111111111111111111111";
  const { id: s1 } = createMobileSession(db, userId, t1, null);
  const d1 = insertMobileDevice(db, {
    userId,
    sessionId: s1,
    name: "Phone 1",
    platform: "ios",
    publicKeySpki: "spki1",
  });

  const t2 = "hmob_222222222222222222222222222222222222222222";
  const { id: s2 } = createMobileSession(db, userId, t2, null);
  insertMobileDevice(db, {
    userId,
    sessionId: s2,
    name: "Phone 2",
    platform: "android",
    publicKeySpki: "spki2",
  });

  expect(listMobileDevices(db, userId)).toHaveLength(2);

  revokeSession(db, userId, s2);
  expect(listMobileDevices(db, userId).map((d) => d.id)).toEqual([d1]);

  setSystemTime(new Date(Date.now() + 31 * DAY));
  expect(listMobileDevices(db, userId)).toHaveLength(0);
});
