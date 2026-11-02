import { expect, test } from "bun:test";
import { sessionHeaders } from "../../test-support/app-kit";
import { mintRunToken } from "../mcp/api";
import { createEnrollment } from "./api";
import { bootKit, cookieOf, PORT } from "./routes-kit";

test("bootstrap enroll registers a passkey, returns recovery codes, sets the cookie, makes a personal org", async () => {
  const kit = bootKit();
  const res = await kit.enroll();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.recoveryCodes).toHaveLength(10);
  expect(body.user.instanceAdmin).toBe(true);
  const setCookie = res.headers.get("set-cookie") ?? "";
  for (const part of [
    "harness_session=",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=2592000",
  ]) {
    expect(setCookie).toContain(part);
  }
  expect(setCookie).not.toContain("Secure");
  expect(kit.db.query("SELECT count(*) AS n FROM passkeys").get()).toEqual({ n: 1 });
  expect(kit.db.query("SELECT name FROM orgs").all()).toEqual([{ name: "Personal" }]);
  const me = await kit.call("GET", "/api/auth/me", undefined, { cookie: cookieOf(res) });
  expect((await me.json()).orgs).toHaveLength(1);
});

test("an https origin makes the cookie Secure, and an enrollment code works once", async () => {
  const kit = bootKit("https://harness.example.com");
  const bogus = await kit.call("POST", "/api/auth/enroll/abc/options", {
    email: "b@example.com",
    name: "B",
  });
  expect(bogus.status).toBe(400);
  const fresh = createEnrollment(kit.db, { ttlMs: 60_000 });
  expect((await kit.enroll(fresh)).headers.get("set-cookie")).toContain("Secure");
  const again = await kit.call("POST", `/api/auth/enroll/${fresh}/options`, {
    email: "b@example.com",
    name: "B",
  });
  expect(again.status).toBe(400);
});

test("login with the soft authenticator sets a cookie that opens /api/auth/me", async () => {
  const kit = bootKit();
  await kit.enroll();
  const cookie = await kit.login();
  expect(cookie).toStartWith("harness_session=");
  const me = await kit.call("GET", "/api/auth/me", undefined, { cookie });
  expect(me.status).toBe(200);
  const body = await me.json();
  expect(body.user.email).toBe("owner@example.com");
  expect(body.session).toMatchObject({ method: "passkey", stepUpFresh: false });
  expect((await kit.call("POST", "/api/auth/login/verify", { challengeId: "x" })).status).toBe(400);
  expect((await kit.call("GET", "/api/auth/me")).status).toBe(401);
});

test("a run bearer token opens nothing on /api/runs, a non-admin user is forbidden", async () => {
  const kit = bootKit();
  const token = mintRunToken(kit.db, "r1", ["report", "guard_hook"]);
  const bearer = { authorization: `Bearer ${token}` };
  expect((await kit.call("GET", "/api/runs", undefined, bearer)).status).toBe(401);
  const { headers } = await sessionHeaders(kit.db, { admin: false });
  expect((await kit.call("GET", "/api/runs", undefined, headers)).status).toBe(403);
  const admin = await sessionHeaders(kit.db, { admin: true });
  expect((await kit.call("GET", "/api/runs", undefined, admin.headers)).status).toBe(200);
});

test("an approval decision needs step-up, then goes through as the user", async () => {
  const kit = bootKit();
  await kit.enroll();
  const cookie = await kit.login();
  const now = Date.now();
  kit.db.run(
    "INSERT INTO approvals (id, run_id, action, l1, status, created_at, expires_at) VALUES ('a1', 'r1', '{\"command\":\"ls\",\"paths\":[]}', '{}', 'pending', ?, ?)",
    [now, now + 60_000],
  );
  const decide = (): Promise<Response> =>
    kit.call("POST", "/api/approvals/a1", { decision: "approve" }, { cookie });
  const refused = await decide();
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "step_up_required" });
  expect((await kit.stepUp(cookie)).status).toBe(200);
  expect((await decide()).status).toBe(200);
  const row = kit.db.query<{ decided_by: string }, []>("SELECT decided_by FROM approvals").get();
  expect(row?.decided_by).toStartWith("user:");
});

test("an email-code session cannot step up with a code, only with a passkey", async () => {
  const kit = bootKit();
  await kit.enroll();
  expect(
    (await kit.call("POST", "/api/auth/email/request", { email: "nobody@example.com" })).status,
  ).toBe(200);
  expect(kit.sent).toEqual([]);
  expect(
    (await kit.call("POST", "/api/auth/email/request", { email: "owner@example.com" })).status,
  ).toBe(200);
  await Bun.sleep(0);
  const code = kit.sent[0]?.code ?? "";
  const verified = await kit.call("POST", "/api/auth/email/verify", {
    email: "owner@example.com",
    code,
  });
  expect(verified.status).toBe(200);
  const cookie = cookieOf(verified);
  const attempt = await kit.call(
    "POST",
    "/api/auth/step-up/verify",
    { challengeId: code, response: { code } },
    { cookie },
  );
  expect(attempt.status).toBe(400);
  const forged = await kit.call(
    "POST",
    "/api/auth/step-up/verify",
    {
      challengeId: code,
      response: {
        id: "x",
        rawId: "x",
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "x", authenticatorData: "x", signature: "x" },
      },
    },
    { cookie },
  );
  expect(forged.status).toBe(401);
  const decide = await kit.call("POST", "/api/halt", { halted: true }, { cookie });
  expect(decide.status).toBe(403);
  expect(await decide.json()).toEqual({ error: "step_up_required" });
});

test("a slow email deliverer cannot hold up the response", async () => {
  const kit = bootKit();
  await kit.enroll();
  kit.deliver.fn = () => new Promise<void>(() => {});
  const res = await kit.call("POST", "/api/auth/email/request", { email: "owner@example.com" });
  expect(res.status).toBe(200);
});

test("the 11th login attempt in a minute is 429", async () => {
  const kit = bootKit();
  for (let i = 0; i < 10; i++) {
    expect((await kit.call("POST", "/api/auth/login/options")).status).toBe(200);
  }
  expect((await kit.call("POST", "/api/auth/login/options")).status).toBe(429);
});

test("a foreign or missing Origin on POST is 403, and GET / on 127.0.0.1 redirects", async () => {
  const kit = bootKit();
  for (const origin of ["http://evil.test", `http://127.0.0.1:${PORT}`]) {
    expect((await kit.call("POST", "/api/auth/login/options", undefined, { origin })).status).toBe(
      403,
    );
  }
  const loopback = await kit.request("/", { host: `127.0.0.1:${PORT}` });
  expect(loopback.status).toBe(302);
  expect(loopback.headers.get("location")).toBe(kit.origin);
});
