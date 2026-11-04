import { afterAll, expect, test } from "bun:test";
import { api } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { lazyBoot } from "../kit/server";

const sessions = {} as Record<"admin" | "stepUp" | "member" | "expired" | "revoked", SeededSession>;

const lazy = lazyBoot({
  seed: (db) => {
    sessions.admin = seedSession(db, { admin: true });
    sessions.stepUp = seedSession(db, { admin: true, stepUp: true });
    sessions.member = seedSession(db);
    sessions.expired = seedSession(db, { admin: true, expired: true });
    sessions.revoked = seedSession(db, { admin: true, revoked: true });
  },
});
afterAll(() => lazy.stop());

async function expectError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

test("C1-session-auth: the cookie is required [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  expect((await api(server, sessions.admin).call("GET", "/api/auth/me")).status).toBe(200);
  await expectError(await api(server).call("GET", "/api/auth/me"), 401, "unauthorized");
  const garbage = { ...sessions.admin, cookie: "harness_session=not-a-token" };
  await expectError(await api(server, garbage).call("GET", "/api/auth/me"), 401, "unauthorized");
});

test("C1-session-auth: expired and revoked sessions give 401 [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  for (const key of ["expired", "revoked"] as const) {
    const res = await api(server, sessions[key]).call("GET", "/api/auth/me");
    await expectError(res, 401, "unauthorized");
  }
});

test("C1-session-auth: a bearer token is not a session [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  const res = await api(server).call("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${sessions.admin.token}` },
  });
  await expectError(res, 401, "unauthorized");
});

test("C1-session-auth: host guard [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  const me = api(server, sessions.admin);
  await expectError(
    await me.call("GET", "/api/auth/me", { headers: { host: "evil.test" } }),
    403,
    "forbidden host",
  );
  // The loopback address is only allowed for the paths agents and probes use.
  await expectError(
    await me.call("GET", "/api/auth/me", { headers: { host: `127.0.0.1:${server.port}` } }),
    403,
    "forbidden host",
  );
  const health = await me.call("GET", "/api/health", {
    headers: { host: `127.0.0.1:${server.port}` },
  });
  expect(health.status).toBe(200);
});

test("C1-session-auth: origin guard on mutations [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  const me = api(server, sessions.admin);
  await expectError(
    await me.call("POST", "/api/auth/logout", { headers: { origin: null } }),
    403,
    "forbidden origin",
  );
  await expectError(
    await me.call("POST", "/api/auth/logout", { headers: { origin: "http://evil.test" } }),
    403,
    "forbidden origin",
  );
  // The guard runs before the session lookup, so a good origin without a cookie reaches the 401.
  await expectError(await api(server).call("POST", "/api/auth/logout"), 401, "unauthorized");
});

test("C1-session-auth: admin and step-up gates [phase:1] [slice:auth] [focus:1]", async () => {
  const server = await lazy.get();
  await expectError(await api(server, sessions.member).call("GET", "/api/runs"), 403, "forbidden");
  const list = await api(server, sessions.admin).call("GET", "/api/runs");
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([]);
  const halt = { body: { halted: false } };
  await expectError(
    await api(server, sessions.admin).call("POST", "/api/halt", halt),
    403,
    "step_up_required",
  );
  const done = await api(server, sessions.stepUp).call("POST", "/api/halt", halt);
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ halted: false });
});
