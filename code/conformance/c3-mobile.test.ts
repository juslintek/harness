import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { api, openWs, until } from "./kit/client";
import { type Booted, lazyBoot } from "./kit/server";

interface Device {
  publicKeySpki: string;
  sign: (payload: string) => Promise<string>;
}

interface Enrolled {
  token: string;
  deviceId: string;
  userId: string;
  orgId: string;
}

const lazy = lazyBoot({});
afterAll(() => lazy.stop());

async function createDevice(): Promise<Device> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const publicKeySpki = Buffer.from(spki).toString("base64url");
  return {
    publicKeySpki,
    sign: async (payload: string): Promise<string> => {
      const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        kp.privateKey,
        new TextEncoder().encode(payload),
      );
      return Buffer.from(sig).toString("base64url");
    },
  };
}

const enrollPayload = (origin: string, challengeId: string, nonce: string): string =>
  `harness-mobile-enroll-v1|${origin}|${challengeId}|${nonce}`;

const stepUpPayload = (origin: string, sessId: string, chalId: string, nonce: string): string =>
  `harness-mobile-stepup-v1|${origin}|${sessId}|${chalId}|${nonce}`;

async function firstRunCode(server: Booted): Promise<string> {
  await until(() => /first-run enrollment: .*\n/.test(server.stdout()), "the first-run line");
  return /#\/enroll\/([a-z2-7-]+)$/m.exec(server.stdout())?.[1] ?? "";
}

async function performEnroll(server: Booted, device: Device): Promise<Enrolled> {
  const code = await firstRunCode(server);
  const optRes = await api(server).call("POST", `/api/auth/mobile/enroll/${code}/options`, {
    headers: { "x-harness-mobile": "1" },
    body: { deviceName: "iPhone 16", platform: "ios", email: "alice@example.com", name: "Alice" },
  });
  expect(optRes.status).toBe(200);
  const opt = (await optRes.json()) as { challengeId: string; nonce: string; userId: string };
  const sig = await device.sign(enrollPayload(server.origin, opt.challengeId, opt.nonce));

  const verRes = await api(server).call("POST", `/api/auth/mobile/enroll/${code}/verify`, {
    headers: { "x-harness-mobile": "1" },
    body: {
      challengeId: opt.challengeId,
      userId: opt.userId,
      deviceName: "iPhone 16",
      platform: "ios",
      publicKeySpki: device.publicKeySpki,
      signature: sig,
    },
  });
  expect(verRes.status).toBe(200);
  const ver = (await verRes.json()) as { token: string; deviceId: string; recoveryCodes: string[] };
  expect(ver.token).toStartWith("hmob_");
  expect(ver.recoveryCodes).toHaveLength(10);

  const me = await api(server).json<{ orgs: { id: string }[] }>("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${ver.token}` },
  });
  return {
    token: ver.token,
    deviceId: ver.deviceId,
    userId: opt.userId,
    orgId: me.orgs[0]?.id ?? "",
  };
}

function injectCookieSession(server: Booted, userId: string): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const tokenHash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  const now = Date.now();
  const db = new Database(join(server.home, "harness.db"));
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at)
     VALUES (?, ?, ?, 'passkey', 'test', ?, ?, ?, ?)`,
    [Bun.randomUUIDv7(), userId, tokenHash, now, now, now + 86400000, now],
  );
  db.close();
  return `harness_session=${token}`;
}

let device: Device;
let enrolled: Enrolled;

test("C3-mobile: enrollment with WebCrypto P-256 SPKI/P1363 signature [slice:mobile] [focus:enroll]", async () => {
  const server = await lazy.get();
  device = await createDevice();
  enrolled = await performEnroll(server, device);
  expect(enrolled.token).toStartWith("hmob_");
  expect(enrolled.orgId).toBeTruthy();
});

test("C3-mobile: authenticated GET /api/auth/me and /ws without cookies [slice:mobile] [focus:auth]", async () => {
  const server = await lazy.get();
  const meRes = await api(server).call("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${enrolled.token}` },
  });
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as { session: { method: string }; orgs: { id: string }[] };
  expect(me.session.method).toBe("mobile");
  expect(me.orgs.some((o) => o.id === enrolled.orgId)).toBe(true);

  const ws = await openWs(server, `org:${enrolled.orgId}`, undefined as never, {
    authorization: `Bearer ${enrolled.token}`,
  });
  expect(ws).toBeDefined();
  ws.close();
});

test("C3-mobile: CSRF origin isolation between cookie and bearer token [slice:mobile] [focus:csrf]", async () => {
  const server = await lazy.get();
  const cookie = injectCookieSession(server, enrolled.userId);

  const noOrigin = await api(server, { cookie }).call("POST", "/api/orgs", {
    headers: { origin: null },
    body: { name: "No Origin Org", slug: "no-origin-org" },
  });
  expect(noOrigin.status).toBe(403);

  const badBearer = await api(server, { cookie }).call("POST", "/api/orgs", {
    headers: { authorization: "Bearer hmob_invalid" },
    body: { name: "Bad Bearer Org", slug: "bad-bearer-org" },
  });
  expect(badBearer.status).toBe(401);

  const goodBearer = await api(server).call("POST", "/api/orgs", {
    headers: { origin: null, authorization: `Bearer ${enrolled.token}` },
    body: { name: "Mobile Org", slug: "mobile-org" },
  });
  expect(goodBearer.status).toBe(201);
});

test("C3-mobile: step-up round-trip, signature verification and replay rejection [slice:mobile] [focus:stepup]", async () => {
  const server = await lazy.get();
  const db = new Database(join(server.home, "harness.db"));
  db.run("UPDATE sessions SET step_up_at = ? WHERE method = 'mobile'", [
    Date.now() - 10 * 60 * 1000,
  ]);
  db.close();

  const haltStale = await api(server).call("POST", "/api/halt", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: { halted: true },
  });
  expect(haltStale.status).toBe(403);
  expect((await haltStale.json()) as { error: string }).toEqual({ error: "step_up_required" });

  const optRes = await api(server).call("POST", "/api/auth/mobile/step-up/options", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: {},
  });
  expect(optRes.status).toBe(200);
  const { challengeId, nonce } = (await optRes.json()) as { challengeId: string; nonce: string };

  const me = await api(server).json<{ session: { id: string } }>("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${enrolled.token}` },
  });
  const sig = await device.sign(stepUpPayload(server.origin, me.session.id, challengeId, nonce));

  const verRes = await api(server).call("POST", "/api/auth/mobile/step-up/verify", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: { challengeId, signature: sig },
  });
  expect(verRes.status).toBe(200);
  expect(((await verRes.json()) as { ok: boolean }).ok).toBe(true);

  const replay = await api(server).call("POST", "/api/auth/mobile/step-up/verify", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: { challengeId, signature: sig },
  });
  expect(replay.status).toBe(400);

  const haltDone = await api(server).call("POST", "/api/halt", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: { halted: false },
  });
  expect(haltDone.status).toBe(200);
});

test("C3-mobile: mobile push target registration and listing [slice:mobile] [focus:notify]", async () => {
  const server = await lazy.get();
  const regRes = await api(server).call("POST", "/api/notify/push/mobile", {
    headers: { authorization: `Bearer ${enrolled.token}` },
    body: {
      relayUrl: `http://127.0.0.1:${server.port}/relay`,
      platform: "ios",
      appId: "com.example.harness",
      pushToken: "0123456789abcdef0123456789abcdef",
      relaySecret: "0123456789abcdef0123456789abcdef",
    },
  });
  expect(regRes.status).toBe(201);
  const { id } = (await regRes.json()) as { id: string };

  const listRes = await api(server).call("GET", "/api/notify/targets", {
    headers: { authorization: `Bearer ${enrolled.token}` },
  });
  expect(listRes.status).toBe(200);
  const targets = (await listRes.json()) as { id: string; channel: string }[];
  expect(targets.some((t) => t.id === id && t.channel === "push")).toBe(true);
});

test("C3-mobile: device revocation closes open /ws with 4401 and invalidates token [slice:mobile] [focus:revoke]", async () => {
  const server = await lazy.get();
  const ws = await openWs(server, `org:${enrolled.orgId}`, undefined as never, {
    authorization: `Bearer ${enrolled.token}`,
  });

  const delRes = await api(server).call("DELETE", `/api/auth/mobile/devices/${enrolled.deviceId}`, {
    headers: { authorization: `Bearer ${enrolled.token}` },
  });
  expect(delRes.status).toBe(200);

  const code = await ws.closed;
  expect(code).toBe(4401);

  const meRevoked = await api(server).call("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${enrolled.token}` },
  });
  expect(meRevoked.status).toBe(401);
});
