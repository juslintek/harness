import { afterEach, expect, setSystemTime, test } from "bun:test";
import { bootKit, cookieOf } from "./routes-kit";

afterEach(() => setSystemTime());

test("two sessions are listed, revoking the other one needs step-up and kills its cookie", async () => {
  const kit = bootKit();
  const first = cookieOf(await kit.enroll());
  const second = await kit.login();
  const list = await (
    await kit.call("GET", "/api/auth/sessions", undefined, { cookie: second })
  ).json();
  expect(list).toHaveLength(2);
  const other = list.find((s: { current: boolean }) => !s.current);
  const revoke = (): Promise<Response> =>
    kit.call("DELETE", `/api/auth/sessions/${other.id}`, undefined, { cookie: second });
  expect((await revoke()).status).toBe(403);
  expect((await kit.stepUp(second)).status).toBe(200);
  expect((await revoke()).status).toBe(200);
  expect((await kit.call("GET", "/api/auth/me", undefined, { cookie: first })).status).toBe(401);
  expect((await kit.call("GET", "/api/auth/me", undefined, { cookie: second })).status).toBe(200);
});

test("logout revokes the current session", async () => {
  const kit = bootKit();
  const enrolled = cookieOf(await kit.enroll());
  expect((await kit.call("POST", "/api/auth/logout", undefined, { cookie: enrolled })).status).toBe(
    200,
  );
  expect((await kit.call("GET", "/api/auth/me", undefined, { cookie: enrolled })).status).toBe(401);
});

test("deleting the last passkey is 409, and passkey changes need step-up", async () => {
  const kit = bootKit();
  await kit.enroll();
  const cookie = await kit.login();
  const list = (): Promise<{ id: string }[]> =>
    kit.call("GET", "/api/auth/passkeys", undefined, { cookie }).then((r) => r.json());
  const [only] = await list();
  const remove = (id: string): Promise<Response> =>
    kit.call("DELETE", `/api/auth/passkeys/${id}`, undefined, { cookie });
  expect((await remove(only?.id ?? "")).status).toBe(403);
  await kit.stepUp(cookie);
  expect((await remove(only?.id ?? "")).status).toBe(409);
  const options = await (
    await kit.call("POST", "/api/auth/passkeys/options", {}, { cookie })
  ).json();
  const response = await kit.authn.create(options);
  const added = await kit.call(
    "POST",
    "/api/auth/passkeys/verify",
    { challengeId: options.challengeId, response, name: "Phone" },
    { cookie },
  );
  expect(added.status).toBe(200);
  expect(await list()).toHaveLength(2);
  expect((await remove(only?.id ?? "")).status).toBe(200);
  const [left] = await list();
  expect((await remove(left?.id ?? "")).status).toBe(409);
});

test("a recovery code logs in once and regenerating replaces the set", async () => {
  const kit = bootKit();
  const enrolled = await (await kit.enroll()).json();
  const [code, spare] = enrolled.recoveryCodes as string[];
  const login = await kit.call("POST", "/api/auth/recovery", { email: "owner@example.com", code });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login);
  expect(
    (await kit.call("POST", "/api/auth/recovery", { email: "owner@example.com", code })).status,
  ).toBe(401);
  const fresh = await kit.call("POST", "/api/auth/recovery/regenerate", {}, { cookie });
  expect((await fresh.json()).recoveryCodes).toHaveLength(10);
  expect(
    (await kit.call("POST", "/api/auth/recovery", { email: "owner@example.com", code: spare }))
      .status,
  ).toBe(401);
});

test("a request that slides the session expiry re-sets the cookie, later ones in the hour do not", async () => {
  const kit = bootKit();
  const cookie = cookieOf(await kit.enroll());
  const me = (): Promise<Response> => kit.call("GET", "/api/auth/me", undefined, { cookie });
  expect((await me()).headers.get("set-cookie")).toBeNull();
  setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
  const slid = await me();
  expect(slid.headers.get("set-cookie")).toContain(`${cookie}; Max-Age=2592000`);
  expect((await me()).headers.get("set-cookie")).toBeNull();
});
