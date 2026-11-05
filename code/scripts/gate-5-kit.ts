// Building blocks for the Phase 5 gate: a booted instance reached over real HTTP, a browser
// stand-in (software passkey) and the pure checks on what the notification channels received.
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { createEnrollment, firstRunEnrollment } from "../src/server/features/auth/api";
import { wireBoard } from "../src/server/features/board/api";
import { wireChat } from "../src/server/features/chat/api";
import { startNotify } from "../src/server/features/notify/api";
import { wireRuntimes } from "../src/server/features/runtimes/api";
import { createTunnel, type Tunnel } from "../src/server/features/tunnel/api";
import { createApp } from "../src/server/http";
import { listenDeferred } from "../src/server/test-support/app-kit";
import type { Receiver } from "../src/server/test-support/push-stub";
import {
  createSoftAuthenticator,
  type SoftAuthenticator,
} from "../src/server/test-support/soft-authenticator";

export type Db = Database;

export interface Report {
  check: (n: number, ok: boolean, what: string) => void;
  // Distinct numbered assertions that passed.
  passed: () => number;
  failures: () => string[];
}

export function createReport(print: (line: string) => void = console.log): Report {
  const outcome = new Map<number, boolean>();
  const failed: string[] = [];
  return {
    check(n, ok, what) {
      outcome.set(n, (outcome.get(n) ?? true) && ok);
      if (!ok) failed.push(`${n} ${what}`);
      print(`${ok ? "PASS" : "FAIL"}  ${n}  ${what}`);
    },
    passed: () => [...outcome.values()].filter(Boolean).length,
    failures: () => failed,
  };
}

// The receiver recomputes the signature the way its documentation tells a customer to, from the
// raw body and the secret, so a bug in the sender's own sign() cannot hide itself.
export function webhookProblem(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowMs: number,
  maxAgeS = 300,
): string | null {
  const stamp = headers.get("x-harness-timestamp") ?? "";
  const given = headers.get("x-harness-signature") ?? "";
  const seconds = Number(stamp);
  if (!Number.isInteger(seconds)) return "timestamp header is missing or not a number";
  if (Math.abs(nowMs / 1000 - seconds) > maxAgeS) return "timestamp is stale";
  const expected = new Bun.CryptoHasher("sha256", secret)
    .update(`${stamp}.${rawBody}`)
    .digest("hex");
  return given === `sha256=${expected}` ? null : "signature does not match";
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// What a service worker would see after decrypting; null when the bytes are not a push message.
export function decodePush(receiver: Receiver, body: Buffer): PushPayload | null {
  try {
    const parsed: unknown = JSON.parse(receiver.decrypt(body));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { title, body: text, url, tag } = parsed as Record<string, unknown>;
    const strings = [title, text, url, tag];
    if (!strings.every((s) => typeof s === "string")) return null;
    return { title, body: text, url, tag } as PushPayload;
  } catch {
    return null;
  }
}

export const approvalPath = (id: string): string => `/#/approvals/${id}`;

export interface Client {
  origin: string;
  call: (
    method: string,
    path: string,
    opts?: { body?: unknown; cookie?: string; form?: boolean },
  ) => Promise<Response>;
}

// The app only answers its configured Host, so a loopback client sends that Host and Origin the
// way the browser would.
export function makeClient(port: number, origin: string): Client {
  const host = new URL(origin).host;
  return {
    origin,
    call(method, path, opts = {}) {
      const headers: Record<string, string> = { host, origin };
      if (opts.cookie) headers.cookie = opts.cookie;
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["content-type"] = opts.form
          ? "application/x-www-form-urlencoded"
          : "application/json";
        body = opts.form
          ? new URLSearchParams(opts.body as Record<string, string>).toString()
          : JSON.stringify(opts.body);
      }
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
      });
    },
  };
}

export const cookieOf = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

export interface Instance {
  db: Db;
  home: string;
  port: number;
  origin: string;
  client: Client;
  authn: SoftAuthenticator;
  tunnel: Tunnel;
  stop: () => Promise<void>;
}

export interface BootOpts {
  home: string;
  // https tunnel origin for Part B; Part A serves on localhost.
  origin?: string;
  port?: number;
  tunnelBin?: string;
}

// Same wiring as main.ts for what the gate touches. The home is created here so the caller can
// pass a path inside its temp directory.
export async function bootInstance(opts: BootOpts): Promise<Instance> {
  mkdirSync(opts.home, { recursive: true });
  const db = openDb(join(opts.home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  wireBoard(db);
  wireChat(db);
  wireRuntimes();
  const listener = listenDeferred(opts.port ?? 0);
  const origin = opts.origin ?? `http://localhost:${listener.port}`;
  const rp = { id: new URL(origin).hostname, name: "Harness", origin };
  const tunnel = createTunnel({
    home: opts.home,
    port: listener.port,
    ...(opts.tunnelBin === undefined ? {} : { bin: opts.tunnelBin }),
  });
  listener.attach(
    createApp({
      db,
      home: opts.home,
      port: listener.port,
      rp,
      instanceId,
      version: "gate5",
      tunnel,
    }),
  );
  const stopNotify = startNotify(db, { home: opts.home, origin });
  return {
    db,
    home: opts.home,
    port: listener.port,
    origin,
    client: makeClient(listener.port, origin),
    authn: createSoftAuthenticator(rp),
    tunnel,
    stop: async () => {
      await stopNotify();
      await listener.server.stop(true);
    },
  };
}

export interface Session {
  cookie: string;
  userId: string;
}

// The first-run link a fresh instance prints, redeemed with the software passkey.
export async function enrollAdmin(inst: Instance): Promise<Session> {
  const code = firstRunEnrollment(inst.db, 60_000) ?? "";
  return enrollWithCode(inst, code, { email: "admin@gate5.test", name: "Gate Admin" });
}

export async function enrollWithCode(
  inst: Instance,
  code: string,
  who: { email: string; name: string },
): Promise<Session> {
  const opts = await (
    await inst.client.call("POST", `/api/auth/enroll/${code}/options`, { body: who })
  ).json();
  const response = await inst.authn.create(opts);
  const res = await inst.client.call("POST", `/api/auth/enroll/${code}/verify`, {
    body: { challengeId: opts.challengeId, userId: opts.userId, response, name: "Gate key" },
  });
  if (res.status !== 200) throw new Error(`enrol failed: ${res.status} ${await res.text()}`);
  return { cookie: cookieOf(res), userId: opts.userId };
}

// A new session with no step-up, the way a person signing in again would get one.
export async function signIn(inst: Instance): Promise<string> {
  const opts = await (await inst.client.call("POST", "/api/auth/login/options")).json();
  const response = await inst.authn.get(opts);
  const res = await inst.client.call("POST", "/api/auth/login/verify", {
    body: { challengeId: opts.challengeId, response },
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return cookieOf(res);
}

export async function stepUp(inst: Instance, cookie: string): Promise<void> {
  const opts = await (
    await inst.client.call("POST", "/api/auth/step-up/options", { cookie, body: {} })
  ).json();
  const response = await inst.authn.get(opts);
  const res = await inst.client.call("POST", "/api/auth/step-up/verify", {
    cookie,
    body: { challengeId: opts.challengeId, response },
  });
  if (res.status !== 200) throw new Error(`step-up failed: ${res.status}`);
}

// One-time link for a real person to enrol their own passkey on this instance's origin.
export function enrolUrl(inst: Instance, userId: string, ttlMs: number): string {
  return `${inst.origin}/#/enroll/${createEnrollment(inst.db, { userId, ttlMs })}`;
}

export async function waitFor<T>(
  what: string,
  read: () => T | null | undefined | false,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
