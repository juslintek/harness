import { expect, test } from "bun:test";
import {
  bootMobileTest,
  createTestDevice,
  enrollMobile,
  setupPasskeyUser,
} from "../../test-support/mobile-kit";
import { createEnrollment } from "./api";
import { pairPayload, stepUpPayload } from "./mobile-crypto";

test("mobile enrollment options, P-256 SPKI/P1363 verify, recovery codes, and replay rejection", async () => {
  const env = bootMobileTest();
  const device = await createTestDevice();
  const res = await enrollMobile(env, device);

  expect(res.optRes.status).toBe(200);
  expect(res.opt.rpOrigin).toBe(env.origin);
  expect(res.verifyRes.status).toBe(200);
  expect(res.token).toStartWith("hmob_");
  expect(res.recoveryCodes).toHaveLength(10);
  expect(res.user.email).toBe("alice@example.com");

  const replay = await env.req(`/api/auth/mobile/enroll/${res.code}/verify`, {
    method: "POST",
    body: res.verifyBody,
    headers: { "x-harness-mobile": "1" },
  });
  expect(replay.status).toBe(400);

  const me = await env.req("/api/auth/me", { headers: { authorization: `Bearer ${res.token}` } });
  expect(me.status).toBe(200);
  expect((await me.json()).session.method).toBe("mobile");
});

test("logged-in passkey user pair/start requires step-up, pair options + verify works and rejects replay", async () => {
  const env = bootMobileTest();
  const { cookie, noStepUpCookie } = await setupPasskeyUser(env);
  const device = await createTestDevice();

  const unauthedPair = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { origin: env.origin, cookie: noStepUpCookie },
  });
  expect(unauthedPair.status).toBe(403);
  expect((await unauthedPair.json()).error).toBe("step_up_required");

  const start = await (
    await env.req("/api/auth/mobile/pair/start", {
      method: "POST",
      body: {},
      headers: { origin: env.origin, cookie },
    })
  ).json();
  expect(start.code).toBeTruthy();
  expect(start.uri).toStartWith("harness://pair?");

  const pairOpt = await (
    await env.req("/api/auth/mobile/pair/options", {
      method: "POST",
      body: { code: start.code, deviceName: "Pixel 9", platform: "android" },
      headers: { "x-harness-mobile": "1" },
    })
  ).json();
  const sig = await device.sign(pairPayload(pairOpt.rpOrigin, pairOpt.challengeId, pairOpt.nonce));
  const verifyBody = {
    challengeId: pairOpt.challengeId,
    code: start.code,
    deviceName: "Pixel 9",
    platform: "android" as const,
    publicKeySpki: device.publicKeySpki,
    signature: sig,
  };
  const verifyRes = await env.req("/api/auth/mobile/pair/verify", {
    method: "POST",
    body: verifyBody,
    headers: { "x-harness-mobile": "1" },
  });
  expect(verifyRes.status).toBe(200);
  expect((await verifyRes.json()).token).toStartWith("hmob_");

  const replay = await env.req("/api/auth/mobile/pair/verify", {
    method: "POST",
    body: verifyBody,
    headers: { "x-harness-mobile": "1" },
  });
  expect(replay.status).toBe(400);
});

test("CSRF isolation: cookie without origin fails, invalid bearer fails without fallback, bearer with evil origin fails, bearer without origin succeeds", async () => {
  const env = bootMobileTest();
  const { cookie } = await setupPasskeyUser(env);

  const noOriginPost = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { cookie },
  });
  expect(noOriginPost.status).toBe(403);

  const bogusBearer = await env.req("/api/auth/me", {
    headers: {
      origin: env.origin,
      cookie,
      authorization: "Bearer hmob_bogustoken12345678901234567890123456789012",
    },
  });
  expect(bogusBearer.status).toBe(401);

  const device = await createTestDevice();
  const { token } = await enrollMobile(env, device, "bob@example.com");

  const evilOrigin = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
  });
  expect(evilOrigin.status).toBe(403);

  const noOriginBearer = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { authorization: `Bearer ${token}` },
  });
  expect(noOriginBearer.status).toBe(201);
});

test("mobile step-up lifecycle: step-up expiry, wrong signature refusal, and valid P-256 step-up", async () => {
  const env = bootMobileTest();
  const device = await createTestDevice();
  const { token } = await enrollMobile(env, device, "tab@example.com");
  env.db.run("UPDATE sessions SET step_up_at = ? WHERE token_hash = ?", [
    Date.now() - 10 * 60 * 1000,
    new Bun.CryptoHasher("sha256").update(token).digest("hex"),
  ]);

  const pairStart = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { authorization: `Bearer ${token}` },
  });
  expect(pairStart.status).toBe(403);

  const stepUpOpt = await (
    await env.req("/api/auth/mobile/step-up/options", {
      method: "POST",
      body: {},
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();

  const wrongDevice = await createTestDevice();
  const wrongSig = await wrongDevice.sign("wrong-payload");
  const reqStepUp = (sig: string) =>
    env.req("/api/auth/mobile/step-up/verify", {
      method: "POST",
      body: { challengeId: stepUpOpt.challengeId, signature: sig },
      headers: { authorization: `Bearer ${token}` },
    });
  expect((await reqStepUp(wrongSig)).status).toBe(400);

  const me = await (
    await env.req("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const payload = stepUpPayload(env.origin, me.session.id, stepUpOpt.challengeId, stepUpOpt.nonce);
  const goodSig = await device.sign(payload);
  expect((await reqStepUp(goodSig)).status).toBe(200);

  const retry = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: { authorization: `Bearer ${token}` },
  });
  expect(retry.status).toBe(201);
});

test("device revocation invalidates mobile token immediately", async () => {
  const env = bootMobileTest();
  const device = await createTestDevice();
  const { token, deviceId } = await enrollMobile(env, device, "work@example.com");

  const listRes = await env.req("/api/auth/mobile/devices", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(listRes.status).toBe(200);
  const devices = await listRes.json();
  expect(devices).toHaveLength(1);
  expect(devices[0].id).toBe(deviceId);

  const revokeRes = await env.req(`/api/auth/mobile/devices/${deviceId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revokeRes.status).toBe(200);

  const dead = await env.req("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  expect(dead.status).toBe(401);
});

test("concurrent Promise.all replay on step-up/verify ensures exactly one succeeds and one fails", async () => {
  const env = bootMobileTest();
  const device = await createTestDevice();
  const { token } = await enrollMobile(env, device, "race@example.com");

  const stepUpOpt = await (
    await env.req("/api/auth/mobile/step-up/options", {
      method: "POST",
      body: {},
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();

  const me = await (
    await env.req("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const payload = stepUpPayload(env.origin, me.session.id, stepUpOpt.challengeId, stepUpOpt.nonce);
  const sig = await device.sign(payload);

  const req = () =>
    env.req("/api/auth/mobile/step-up/verify", {
      method: "POST",
      body: { challengeId: stepUpOpt.challengeId, signature: sig },
      headers: { authorization: `Bearer ${token}` },
    });

  const [res1, res2] = await Promise.all([req(), req()]);
  const statuses = [res1.status, res2.status].sort();
  expect(statuses).toEqual([200, 400]);
});

test("cookie-authed pair/start without Origin and with X-Harness-Mobile returns 403", async () => {
  const env = bootMobileTest();
  const { cookie } = await setupPasskeyUser(env);

  const res = await env.req("/api/auth/mobile/pair/start", {
    method: "POST",
    body: {},
    headers: {
      cookie,
      "x-harness-mobile": "1",
    },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("forbidden origin");
});

test("verify rejects non-base64url characters in publicKeySpki or signature", async () => {
  const env = bootMobileTest();
  const code = createEnrollment(env.db, { email: "b64@example.com", ttlMs: 60_000 });
  const optRes = await env.req(`/api/auth/mobile/enroll/${code}/options`, {
    method: "POST",
    body: { deviceName: "Phone", platform: "ios", email: "b64@example.com", name: "B64" },
    headers: { "x-harness-mobile": "1" },
  });
  const opt = await optRes.json();
  const badSpkiRes = await env.req(`/api/auth/mobile/enroll/${code}/verify`, {
    method: "POST",
    body: {
      challengeId: opt.challengeId,
      userId: opt.userId,
      deviceName: "Phone",
      platform: "ios",
      publicKeySpki: "bad+spki/with+plus==",
      signature: "badsig",
    },
    headers: { "x-harness-mobile": "1" },
  });
  expect(badSpkiRes.status).toBe(400);
});
