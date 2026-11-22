import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/db";
import { migrations } from "../db/migrations";
import { createEnrollment, createSession } from "../features/auth/api";
import { enrollPayload } from "../features/auth/mobile-crypto";
import type { Rp } from "../features/auth/passkeys";
import { createApp } from "../http";
import { createSoftAuthenticator } from "./soft-authenticator";

const PORT: number = 4100;

export interface MobileTestEnv {
  db: Database;
  app: ReturnType<typeof createApp>;
  origin: string;
  host: string;
  authn: ReturnType<typeof createSoftAuthenticator>;
  rp: Rp;
  req: (
    path: string,
    opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<Response>;
}

export interface TestDevice {
  publicKeySpki: string;
  sign: (payload: string) => Promise<string>;
}

export interface EnrolledMobile {
  code: string;
  optRes: Response;
  opt: { rpOrigin: string; challengeId: string; nonce: string; userId: string };
  signature: string;
  verifyBody: {
    challengeId: string;
    userId: string;
    deviceName: string;
    platform: "ios" | "android";
    publicKeySpki: string;
    signature: string;
  };
  verifyRes: Response;
  token: string;
  deviceId: string;
  user: { id: string; email: string; name: string };
  recoveryCodes: string[];
}

export interface PasskeyUserAuth {
  cookie: string;
  noStepUpCookie: string;
}

export function bootMobileTest(origin = `http://localhost:${PORT}`): MobileTestEnv {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const rp: Rp = { id: new URL(origin).hostname, name: "Harness", origin };
  const app = createApp({
    db,
    home: "/unused",
    port: PORT,
    rp,
    instanceId: "i",
    version: "1",
    deliverEmailCode: () => {},
  });
  const host = new URL(origin).host;
  const authn = createSoftAuthenticator(rp);
  const req = (
    path: string,
    opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        method: opts.method ?? "GET",
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        headers: {
          host,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...opts.headers,
        },
      }),
    );
  return { db, app, origin, host, authn, rp, req };
}

export async function createTestDevice(): Promise<TestDevice> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const publicKeySpki = Buffer.from(spki).toString("base64url");
  const sign = async (payload: string): Promise<string> => {
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      kp.privateKey,
      new TextEncoder().encode(payload),
    );
    return Buffer.from(sig).toString("base64url");
  };
  return { publicKeySpki, sign };
}

export async function enrollMobile(
  env: MobileTestEnv,
  device: TestDevice,
  email = "alice@example.com",
): Promise<EnrolledMobile> {
  const code = createEnrollment(env.db, { email, ttlMs: 60_000 });
  const optRes = await env.req(`/api/auth/mobile/enroll/${code}/options`, {
    method: "POST",
    body: { deviceName: "Phone", platform: "ios", email, name: "Alice" },
    headers: { "x-harness-mobile": "1" },
  });
  const opt = await optRes.json();
  const signature = await device.sign(enrollPayload(opt.rpOrigin, opt.challengeId, opt.nonce));
  const verifyBody = {
    challengeId: opt.challengeId,
    userId: opt.userId,
    deviceName: "Phone",
    platform: "ios" as const,
    publicKeySpki: device.publicKeySpki,
    signature,
  };
  const verifyRes = await env.req(`/api/auth/mobile/enroll/${code}/verify`, {
    method: "POST",
    body: verifyBody,
    headers: { "x-harness-mobile": "1" },
  });
  const data = await verifyRes.json();
  return { code, optRes, opt, signature, verifyBody, verifyRes, ...data };
}

export async function setupPasskeyUser(env: MobileTestEnv): Promise<PasskeyUserAuth> {
  const enrollCode = createEnrollment(env.db, { ttlMs: 60_000 });
  const opt = await (
    await env.req(`/api/auth/enroll/${enrollCode}/options`, {
      method: "POST",
      body: { email: "owner@example.com", name: "Owner" },
      headers: { origin: env.origin },
    })
  ).json();
  const attestation = await env.authn.create(opt);
  const passkeyVerify = await env.req(`/api/auth/enroll/${enrollCode}/verify`, {
    method: "POST",
    body: { challengeId: opt.challengeId, userId: opt.userId, response: attestation, name: "Key" },
    headers: { origin: env.origin },
  });
  const cookie = (passkeyVerify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { token: noStepUpToken } = createSession(env.db, opt.userId, "email", "TestBrowser");
  return { cookie, noStepUpCookie: `harness_session=${noStepUpToken}` };
}
