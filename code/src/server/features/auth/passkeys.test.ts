import { afterEach, expect, setSystemTime, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createSoftAuthenticator } from "../../test-support/soft-authenticator";
import {
  createSession,
  finishLogin,
  finishRegistration,
  finishStepUp,
  hasFreshStepUp,
  loginOptions,
  type Rp,
  registrationOptions,
  type Session,
  sessionFromToken,
  stepUpOptions,
} from "./api";
import { createUser } from "./users";

const rp: Rp = { id: "localhost", name: "Harness", origin: "http://localhost:4100" };

afterEach(() => setSystemTime());

function live(db: ReturnType<typeof openDb>, token: string): Session {
  const session = sessionFromToken(db, token);
  if (!session) throw new Error("no session");
  return session;
}

function setup(): {
  db: ReturnType<typeof openDb>;
  userId: string;
  device: ReturnType<typeof createSoftAuthenticator>;
} {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const userId = createUser(db, { email: "a@example.com", name: "Ada", instanceAdmin: false });
  return { db, userId, device: createSoftAuthenticator(rp) };
}

async function register(x: ReturnType<typeof setup>): Promise<void> {
  const options = await registrationOptions(x.db, rp, x.userId);
  const response = await x.device.create(options);
  const done = await finishRegistration(
    x.db,
    rp,
    x.userId,
    options.challengeId,
    response,
    "laptop",
  );
  expect(done.ok).toBe(true);
}

test("register then login with the soft authenticator returns the user", async () => {
  const x = setup();
  await register(x);
  const options = await loginOptions(x.db, rp);
  expect(options.allowCredentials).toBeUndefined();
  const result = await finishLogin(x.db, rp, options.challengeId, await x.device.get(options));
  expect(result).toEqual({ ok: true, userId: x.userId });
  const row = x.db.query<{ counter: number }, []>("SELECT counter FROM passkeys").get();
  expect(row?.counter).toBe(1);
});

test("replayed challenge fails", async () => {
  const x = setup();
  await register(x);
  const options = await loginOptions(x.db, rp);
  const response = await x.device.get(options);
  expect((await finishLogin(x.db, rp, options.challengeId, response)).ok).toBe(true);
  expect((await finishLogin(x.db, rp, options.challengeId, response)).ok).toBe(false);
});

test("expired challenge (6 min) fails", async () => {
  const x = setup();
  await register(x);
  const options = await loginOptions(x.db, rp);
  const response = await x.device.get(options);
  setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
  expect((await finishLogin(x.db, rp, options.challengeId, response)).ok).toBe(false);
});

test("assertion from an unknown credential fails", async () => {
  const x = setup();
  await register(x);
  const stranger = createSoftAuthenticator(rp);
  await stranger.create(await registrationOptions(x.db, rp, x.userId));
  const options = await loginOptions(x.db, rp);
  const result = await finishLogin(x.db, rp, options.challengeId, await stranger.get(options));
  expect(result).toEqual({ ok: false, reason: "unknown credential" });
});

test("wrong origin fails", async () => {
  const x = setup();
  await register(x);
  const phisher = createSoftAuthenticator({ id: rp.id, origin: "http://evil.test:4100" });
  const options = await registrationOptions(x.db, rp, x.userId);
  const done = await finishRegistration(
    x.db,
    rp,
    x.userId,
    options.challengeId,
    await phisher.create(options),
    "phone",
  );
  expect(done.ok).toBe(false);
  const login = await loginOptions(x.db, rp);
  const forged = await x.device.get(login);
  const tampered = {
    ...forged.response,
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: login.challenge,
        origin: "http://evil.test:4100",
      }),
    ).toString("base64url"),
  };
  const result = await finishLogin(x.db, rp, login.challengeId, { ...forged, response: tampered });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toMatch(/origin/i);
});

test("a counter that went backwards fails", async () => {
  const x = setup();
  await register(x);
  x.db.query("UPDATE passkeys SET counter = 10").run();
  const options = await loginOptions(x.db, rp);
  const result = await finishLogin(x.db, rp, options.challengeId, await x.device.get(options));
  expect(result.ok).toBe(false);
});

test("step-up sets step_up_at and hasFreshStepUp is false after 5 min", async () => {
  const x = setup();
  await register(x);
  const { id, token } = createSession(x.db, x.userId, "passkey", null);
  expect(hasFreshStepUp(live(x.db, token))).toBe(false);
  const options = await stepUpOptions(x.db, rp, x.userId);
  expect(options.allowCredentials?.length).toBe(1);
  const response = await x.device.get(options);
  expect(await finishStepUp(x.db, rp, id, x.userId, options.challengeId, response)).toEqual({
    ok: true,
  });
  const session = live(x.db, token);
  expect(session.stepUpAt).not.toBeNull();
  expect(hasFreshStepUp(session)).toBe(true);
  expect(hasFreshStepUp(session, Date.now() + 5 * 60 * 1000 + 1)).toBe(false);
});

test("step-up challenge issued for another user fails", async () => {
  const x = setup();
  await register(x);
  const other = createUser(x.db, { email: "b@example.com", name: "Bo", instanceAdmin: false });
  const { id } = createSession(x.db, x.userId, "passkey", null);
  const options = await stepUpOptions(x.db, rp, other);
  const response = await x.device.get({ ...options, allowCredentials: [] });
  const result = await finishStepUp(x.db, rp, id, x.userId, options.challengeId, response);
  expect(result.ok).toBe(false);
});

test("step-up with a session of another user fails and sets nothing", async () => {
  const x = setup();
  await register(x);
  const other = createUser(x.db, { email: "b@example.com", name: "Bo", instanceAdmin: false });
  const foreign = createSession(x.db, other, "passkey", null);
  const options = await stepUpOptions(x.db, rp, x.userId);
  const response = await x.device.get(options);
  const result = await finishStepUp(x.db, rp, foreign.id, x.userId, options.challengeId, response);
  expect(result).toEqual({ ok: false, reason: "unknown session" });
  expect(live(x.db, foreign.token).stepUpAt).toBeNull();
});

test("step-up on a revoked session fails", async () => {
  const x = setup();
  await register(x);
  const { id } = createSession(x.db, x.userId, "passkey", null);
  x.db.query("UPDATE sessions SET revoked_at = ?").run(Date.now());
  const options = await stepUpOptions(x.db, rp, x.userId);
  const response = await x.device.get(options);
  expect((await finishStepUp(x.db, rp, id, x.userId, options.challengeId, response)).ok).toBe(
    false,
  );
});

test("registration without user verification is refused", async () => {
  const x = setup();
  const options = await registrationOptions(x.db, rp, x.userId);
  expect(options.authenticatorSelection?.userVerification).toBe("required");
  const response = await x.device.create(options, { userVerified: false });
  const done = await finishRegistration(x.db, rp, x.userId, options.challengeId, response, "weak");
  expect(done.ok).toBe(false);
});

test("step-up requires user verification, login does not", async () => {
  const x = setup();
  await register(x);
  const { id } = createSession(x.db, x.userId, "passkey", null);
  const options = await stepUpOptions(x.db, rp, x.userId);
  expect(options.userVerification).toBe("required");
  const weak = await x.device.get(options, { userVerified: false });
  expect((await finishStepUp(x.db, rp, id, x.userId, options.challengeId, weak)).ok).toBe(false);
  const login = await loginOptions(x.db, rp);
  const response = await x.device.get(login, { userVerified: false });
  expect((await finishLogin(x.db, rp, login.challengeId, response)).ok).toBe(true);
});

test("a challenge of another purpose is refused", async () => {
  const x = setup();
  await register(x);
  const { id } = createSession(x.db, x.userId, "passkey", null);
  const login = await loginOptions(x.db, rp);
  const asStepUp = await finishStepUp(
    x.db,
    rp,
    id,
    x.userId,
    login.challengeId,
    await x.device.get(login),
  );
  expect(asStepUp.ok).toBe(false);
  const reg = await registrationOptions(x.db, rp, x.userId);
  const asLogin = await finishLogin(
    x.db,
    rp,
    reg.challengeId,
    await x.device.get(await loginOptions(x.db, rp)),
  );
  expect(asLogin.ok).toBe(false);
});

test("step-up with another user's credential fails", async () => {
  const x = setup();
  await register(x);
  const other = createUser(x.db, { email: "b@example.com", name: "Bo", instanceAdmin: false });
  const otherDevice = createSoftAuthenticator(rp);
  const reg = await registrationOptions(x.db, rp, other);
  await finishRegistration(x.db, rp, other, reg.challengeId, await otherDevice.create(reg), "bo");
  const { id } = createSession(x.db, x.userId, "passkey", null);
  const options = await stepUpOptions(x.db, rp, x.userId);
  const response = await otherDevice.get({ ...options, allowCredentials: [] });
  const result = await finishStepUp(x.db, rp, id, x.userId, options.challengeId, response);
  expect(result).toEqual({ ok: false, reason: "unknown credential" });
});
