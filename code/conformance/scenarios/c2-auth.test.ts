import { expect, test } from "bun:test";
import { createSoftAuthenticator } from "../../src/server/test-support/soft-authenticator";
import { type Api, api, until } from "../kit/client";
import { type Booted, lazyBoot } from "../kit/server";

// The auth routes allow ten attempts a minute per client, so every test boots its own server and
// stays under that.

type Authn = ReturnType<typeof createSoftAuthenticator>;

interface Enrolled {
  user: { id: string; email: string; name: string; instanceAdmin: boolean; createdAt: number };
  recoveryCodes: string[];
}

interface Rig {
  server: Booted;
  authn: Authn;
  anon: Api;
}

const cookieOf = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function expectError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  // The TS server prints email codes only in development; bun test hands the child NODE_ENV=test.
  const lazy = lazyBoot({ env: { NODE_ENV: "development" } });
  try {
    const server = await lazy.get();
    const authn = createSoftAuthenticator({ id: "localhost", origin: server.origin });
    await run({ server, authn, anon: api(server) });
  } finally {
    await lazy.stop();
  }
}

async function firstRunCode(server: Booted): Promise<string> {
  await until(() => /first-run enrollment: .*\n/.test(server.stdout()), "the first-run line");
  return /#\/enroll\/([a-z2-7-]+)$/m.exec(server.stdout())?.[1] ?? "";
}

async function enrollOwner(rig: Rig): Promise<Enrolled & { cookie: string }> {
  const code = await firstRunCode(rig.server);
  const options = await rig.anon.json<{ challengeId: string; userId: string }>(
    "POST",
    `/api/auth/enroll/${code}/options`,
    { body: { email: "owner@example.com", name: "Owner" } },
  );
  const response = await rig.authn.create(options as never);
  const res = await rig.anon.call("POST", `/api/auth/enroll/${code}/verify`, {
    body: { challengeId: options.challengeId, userId: options.userId, response, name: "Laptop" },
  });
  expect(res.status).toBe(200);
  return { ...((await res.json()) as Enrolled), cookie: cookieOf(res) };
}

async function login(rig: Rig): Promise<{ res: Response; cookie: string }> {
  const options = await rig.anon.json<{ challengeId: string }>("POST", "/api/auth/login/options");
  const response = await rig.authn.get(options as never);
  const res = await rig.anon.call("POST", "/api/auth/login/verify", {
    body: { challengeId: options.challengeId, response },
  });
  return { res, cookie: cookieOf(res) };
}

async function stepUp(rig: Rig, cookie: string): Promise<Response> {
  const me = api(rig.server, { cookie });
  const options = await me.json<{ challengeId: string }>("POST", "/api/auth/step-up/options", {
    body: {},
  });
  const response = await rig.authn.get(options as never);
  return me.call("POST", "/api/auth/step-up/verify", {
    body: { challengeId: options.challengeId, response },
  });
}

async function expectEnrollResponse(res: Response): Promise<void> {
  const header = res.headers.get("set-cookie") ?? "";
  for (const part of ["HttpOnly", "SameSite=Strict", "Max-Age=2592000", "Path=/"]) {
    expect(header).toContain(part);
  }
  const body = (await res.json()) as Enrolled;
  expect(Object.keys(body)).toEqual(["user", "recoveryCodes"]);
  expect(Object.keys(body.user)).toEqual(["id", "email", "name", "instanceAdmin", "createdAt"]);
  expect(body.user).toMatchObject({
    email: "owner@example.com",
    name: "Owner",
    instanceAdmin: true,
  });
  expect(body.recoveryCodes).toHaveLength(10);
  for (const recovery of body.recoveryCodes) {
    expect(recovery).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){2}$/);
  }
}

async function expectPasskeyList(me: Api): Promise<void> {
  const list = await me.json<
    { id: string; name: string; createdAt: number; lastUsedAt: number | null }[]
  >("GET", "/api/auth/passkeys");
  expect(list).toHaveLength(1);
  expect(list[0]?.name).toBe("Laptop");
  expect(Object.keys(list[0] ?? {})).toEqual(["id", "name", "createdAt", "lastUsedAt"]);
  expect(list[0]?.lastUsedAt).not.toBeNull();
  await expectError(
    await me.call("DELETE", `/api/auth/passkeys/${list[0]?.id}`),
    409,
    "cannot delete the last passkey",
  );
  await expectError(await me.call("DELETE", "/api/auth/passkeys/nope"), 404, "unknown passkey");
}

async function expectSessionRevoke(me: Api): Promise<void> {
  const sessions = await me.json<{ id: string; current: boolean }[]>("GET", "/api/auth/sessions");
  expect(sessions.length).toBeGreaterThan(1);
  expect(sessions.filter((s) => s.current)).toHaveLength(1);
  expect(Object.keys(sessions[0] ?? {})).toEqual([
    "id",
    "method",
    "userAgent",
    "createdAt",
    "lastSeenAt",
    "expiresAt",
    "current",
  ]);
  const other = sessions.find((s) => !s.current);
  expect((await me.call("DELETE", `/api/auth/sessions/${other?.id}`)).status).toBe(200);
  await expectError(
    await me.call("DELETE", `/api/auth/sessions/${other?.id}`),
    404,
    "unknown session",
  );
}

test("C2-auth: the first-run link enrolls the owner with a passkey [phase:2] [slice:auth] [focus:1]", () =>
  withRig(async ({ server, authn, anon }) => {
    const code = await firstRunCode(server);
    expect(code).toMatch(/^[a-z2-7]{4}(?:-[a-z2-7]{4}){3}$/);

    await expectError(
      await anon.call("POST", "/api/auth/enroll/aaaa-aaaa-aaaa-aaaa/options", {
        body: { email: "owner@example.com", name: "Owner" },
      }),
      400,
      "enrollment code is not valid",
    );
    await expectError(
      await anon.call("POST", `/api/auth/enroll/${code}/options`, { body: { email: "nope" } }),
      400,
      "invalid body",
    );

    const options = await anon.json<{ challengeId: string; userId: string }>(
      "POST",
      `/api/auth/enroll/${code}/options`,
      { body: { email: " Owner@Example.com ", name: " Owner " } },
    );
    expect(Object.keys(options).slice(-2)).toEqual(["challengeId", "userId"]);
    const response = await authn.create(options as never);
    const res = await anon.call("POST", `/api/auth/enroll/${code}/verify`, {
      body: { challengeId: options.challengeId, userId: options.userId, response, name: "Laptop" },
    });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    await expectEnrollResponse(res);

    // The code is spent.
    await expectError(
      await anon.call("POST", `/api/auth/enroll/${code}/options`, {
        body: { email: "owner@example.com", name: "Owner" },
      }),
      400,
      "enrollment code is not valid",
    );
    const me = await api(server, { cookie }).json<{
      user: { email: string };
      session: { method: string; stepUpFresh: boolean };
    }>("GET", "/api/auth/me");
    expect(me.user.email).toBe("owner@example.com");
    expect(me.session).toMatchObject({ method: "enroll", stepUpFresh: true });
  }));

test("C2-auth: a passkey login opens a session, a replay and bad bodies do not [phase:2] [slice:auth] [focus:1]", () =>
  withRig(async (rig) => {
    await enrollOwner(rig);
    const { server, authn, anon } = rig;
    const options = await anon.json<{ challengeId: string }>("POST", "/api/auth/login/options");
    expect(Object.keys(options)).not.toContain("allowCredentials");
    const response = await authn.get(options as never);
    const first = await anon.call("POST", "/api/auth/login/verify", {
      body: { challengeId: options.challengeId, response },
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { user: { email: string } };
    expect(Object.keys(body)).toEqual(["user"]);
    expect(body.user.email).toBe("owner@example.com");
    const me = await api(server, { cookie: cookieOf(first) }).json<{
      session: { method: string };
    }>("GET", "/api/auth/me");
    expect(me.session.method).toBe("passkey");

    // A challenge is single use, whatever the answer was.
    await expectError(
      await anon.call("POST", "/api/auth/login/verify", {
        body: { challengeId: options.challengeId, response },
      }),
      401,
      "unauthorized",
    );
    await expectError(
      await anon.call("POST", "/api/auth/login/verify", {
        body: { challengeId: "never-issued", response },
      }),
      401,
      "unauthorized",
    );
    for (const bad of [{}, { challengeId: "c" }, { challengeId: 1, response: {} }]) {
      await expectError(
        await anon.call("POST", "/api/auth/login/verify", { body: bad }),
        400,
        "invalid body",
      );
    }
  }));

test("C2-auth: email codes sign in once, unknown addresses look the same [phase:2] [slice:auth] [focus:1]", () =>
  withRig(async (rig) => {
    await enrollOwner(rig);
    const { server, anon } = rig;
    const email = "owner@example.com";
    const ok = await anon.call("POST", "/api/auth/email/request", { body: { email } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const code = await until(
      () => new RegExp(`email code for ${email}: (\\d{6})`).exec(server.stdout())?.[1],
      "the email code line",
    );
    await expectError(
      await anon.call("POST", "/api/auth/email/verify", { body: { email, code: "000000" } }),
      401,
      "unauthorized",
    );
    const res = await anon.call("POST", "/api/auth/email/verify", { body: { email, code } });
    expect(res.status).toBe(200);
    const me = await api(server, { cookie: cookieOf(res) }).json<{
      session: { method: string };
    }>("GET", "/api/auth/me");
    expect(me.session.method).toBe("email");
    await expectError(
      await anon.call("POST", "/api/auth/email/verify", { body: { email, code } }),
      401,
      "unauthorized",
    );
    // An email session never unlocks a dangerous route.
    await expectError(
      await api(server, { cookie: cookieOf(res) }).call("POST", "/api/auth/passkeys/options", {
        body: {},
      }),
      403,
      "step_up_required",
    );

    const ghost = { email: "ghost@example.com" };
    for (let i = 0; i < 3; i++) {
      const answer = await anon.call("POST", "/api/auth/email/request", { body: ghost });
      expect(await answer.json()).toEqual({ ok: true });
    }
    await expectError(
      await anon.call("POST", "/api/auth/email/request", { body: ghost }),
      429,
      "too many attempts",
    );
    expect(server.stdout()).not.toContain("ghost@example.com");
  }));

test("C2-auth: a recovery code signs in once and regenerating replaces the set [phase:2] [slice:auth] [focus:1]", () =>
  withRig(async (rig) => {
    const enrolled = await enrollOwner(rig);
    const { server, anon } = rig;
    const [first = "", second = ""] = enrolled.recoveryCodes;
    const email = "owner@example.com";
    const res = await anon.call("POST", "/api/auth/recovery", {
      body: { email, code: first.toUpperCase() },
    });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    await expectError(
      await anon.call("POST", "/api/auth/recovery", { body: { email, code: first } }),
      401,
      "unauthorized",
    );
    // A recovery session proved possession of a one-time secret, so it may regenerate at once.
    const fresh = await api(server, { cookie }).json<{ recoveryCodes: string[] }>(
      "POST",
      "/api/auth/recovery/regenerate",
      { body: {} },
    );
    expect(fresh.recoveryCodes).toHaveLength(10);
    await expectError(
      await anon.call("POST", "/api/auth/recovery", { body: { email, code: second } }),
      401,
      "unauthorized",
    );
  }));

test("C2-auth: step-up, passkey list, last-passkey rule and session revoke [phase:2] [slice:auth] [focus:1]", () =>
  withRig(async (rig) => {
    await enrollOwner(rig);
    const { cookie } = await login(rig);
    const me = api(rig.server, { cookie });
    await expectError(
      await me.call("POST", "/api/auth/passkeys/options", { body: {} }),
      403,
      "step_up_required",
    );
    await expectError(
      await me.call("POST", "/api/auth/step-up/verify", { body: {} }),
      400,
      "invalid body",
    );

    const done = await stepUp(rig, cookie);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true });
    const state = await me.json<{ session: { stepUpFresh: boolean } }>("GET", "/api/auth/me");
    expect(state.session.stepUpFresh).toBe(true);

    await expectPasskeyList(me);
    await expectSessionRevoke(me);

    // Logging out revokes this session.
    expect((await me.call("POST", "/api/auth/logout", { body: {} })).status).toBe(200);
    await expectError(await me.call("GET", "/api/auth/me"), 401, "unauthorized");
  }));
