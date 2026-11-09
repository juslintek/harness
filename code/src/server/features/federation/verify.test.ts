import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { listenDeferred, sessionHeaders } from "../../test-support/app-kit";
import { signedFetch } from "./client";
import { privateKeyB64, publicKeyB64 } from "./keys";
import { getPeer, insertPeer, revokePeer } from "./peers-repo";
import { type SignParts, signRequest } from "./sign";
import { MAX_BODY_BYTES, type PeerEnv, requirePeer } from "./verify";

interface Node {
  db: Database;
  home: string;
  origin: string;
  instanceId: string;
  stop: () => void;
}

function boot(): Node {
  const home = mkdtempSync(join(tmpdir(), "harness-sig-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  const listener = listenDeferred();
  const origin = `http://localhost:${listener.port}`;
  const rp = { id: "localhost", name: "Harness", origin };
  listener.attach(createApp({ db, home, port: listener.port, rp, instanceId, version: "t" }));
  return { db, home, origin, instanceId, stop: () => void listener.server.stop(true) };
}

function pair(from: Node, to: Node): void {
  insertPeer(from.db, {
    id: to.instanceId,
    name: "peer",
    url: to.origin,
    publicKey: publicKeyB64(to.home),
    pairedAt: 1,
  });
}

let a: Node;
let b: Node;
let c: Node;
let clock = 1_800_000_000_000;

const unit = new Hono<PeerEnv>();

beforeAll(() => {
  a = boot();
  b = boot();
  c = boot();
  pair(a, b);
  pair(a, c);
  pair(b, a);
  unit.use("*", requirePeer(a.db, { now: () => clock }));
  unit.all("*", (ctx) => ctx.json({ peer: ctx.get("peerId"), bytes: ctx.get("rawBody").length }));
});

afterAll(() => {
  for (const node of [a, b, c]) node.stop();
});

interface Sent {
  method?: string;
  path?: string;
  body?: string;
}

function signedAs(
  from: Node,
  sent: Sent,
  over: Partial<SignParts> = {},
): { headers: Record<string, string>; sent: Required<Sent> } {
  const full = { method: "POST", path: "/federation/x?a=1", body: '{"k":1}', ...sent };
  const s = signRequest(privateKeyB64(from.home), {
    instance: from.instanceId,
    method: full.method,
    pathWithQuery: full.path,
    body: full.body,
    timestamp: clock,
    ...over,
  });
  return {
    sent: full,
    headers: {
      "x-harness-instance": s.instance,
      "x-harness-timestamp": s.timestamp,
      "x-harness-nonce": s.nonce,
      "x-harness-signature": s.signature,
    },
  };
}

async function send(
  built: { headers: Record<string, string>; sent: Required<Sent> },
  alter: Sent = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const m = { ...built.sent, ...alter };
  const res = await unit.request(`http://localhost${m.path}`, {
    method: m.method,
    headers: { ...built.headers, ...headers },
    ...(m.method === "GET" ? {} : { body: m.body }),
  });
  return { status: res.status, text: await res.text() };
}

const GENERIC = '{"error":"unauthorized"}';

test("a valid signed request passes, sets the peer and touches last_seen_at", async () => {
  const res = await send(signedAs(b, {}));
  expect(res.status).toBe(200);
  expect(JSON.parse(res.text)).toEqual({ peer: b.instanceId, bytes: 7 });
  expect(getPeer(a.db, b.instanceId)?.lastSeenAt).toBe(clock);
  const get = await send(signedAs(b, { method: "GET", body: "", path: "/federation/ping" }));
  expect(get.status).toBe(200);
});

test("anything altered after signing is refused with the same generic 401", async () => {
  const cases: Array<[Sent, Record<string, string>]> = [
    [{ body: '{"k":2}' }, {}],
    [{ path: "/federation/y?a=1" }, {}],
    [{ path: "/federation/x?a=2" }, {}],
    [{ method: "PUT" }, {}],
    [{}, { "x-harness-timestamp": String(clock + 1) }],
    [{}, { "x-harness-nonce": "other" }],
    [{}, { "x-harness-signature": "AAAA" }],
    [{}, { "x-harness-signature": "" }],
    [{}, { "x-harness-instance": c.instanceId }],
  ];
  const bodies = new Set<string>();
  for (const [alter, headers] of cases) {
    const res = await send(signedAs(b, {}), alter, headers);
    expect(res.status).toBe(401);
    bodies.add(res.text);
  }
  expect([...bodies]).toEqual([GENERIC]);
});

test("a replayed nonce is refused even with a fresh timestamp window", async () => {
  const built = signedAs(b, {});
  expect((await send(built)).status).toBe(200);
  expect((await send(built)).text).toBe(GENERIC);
  clock += 11 * 60_000;
  const old = signedAs(b, {}, { timestamp: clock });
  expect((await send(old)).status).toBe(200);
  expect(a.db.query("SELECT COUNT(*) AS n FROM fed_nonces").get()).toEqual({ n: 1 });
});

test("timestamps 6 minutes old or ahead are refused, 4 minutes pass", async () => {
  for (const skew of [-6 * 60_000, 6 * 60_000]) {
    const res = await send(signedAs(b, {}, { timestamp: clock + skew }));
    expect(res).toEqual({ status: 401, text: GENERIC });
  }
  for (const skew of [-4 * 60_000, 4 * 60_000]) {
    expect((await send(signedAs(b, {}, { timestamp: clock + skew }))).status).toBe(200);
  }
});

test("unknown instance, unsigned and cross-key requests are refused", async () => {
  const stranger = { ...signedAs(b, {}).headers, "x-harness-instance": "nobody" };
  expect(await send({ headers: stranger, sent: signedAs(b, {}).sent })).toEqual({
    status: 401,
    text: GENERIC,
  });
  expect(await send({ headers: {}, sent: signedAs(b, {}).sent })).toEqual({
    status: 401,
    text: GENERIC,
  });
  const forged = signedAs(c, {}, { instance: b.instanceId });
  expect(await send(forged)).toEqual({ status: 401, text: GENERIC });
});

test("an oversized body answers 413 and a revoked peer 401", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  expect((await send(signedAs(b, { body: big }))).status).toBe(413);
  expect(revokePeer(a.db, c.instanceId)).toBe(true);
  expect(await send(signedAs(c, {}))).toEqual({ status: 401, text: GENERIC });
});

test("no key material or secret shows in failures", async () => {
  const texts = [
    (await send(signedAs(b, {}), { body: "tampered" })).text,
    (await send(signedAs(c, {}))).text,
  ];
  for (const text of texts) {
    expect(text).toBe(GENERIC);
    for (const key of [privateKeyB64(a.home), privateKeyB64(b.home), publicKeyB64(b.home)]) {
      expect(text).not.toContain(key);
    }
  }
});

test("over http: ping needs a signature, a session cookie alone grants nothing", async () => {
  const admin = await sessionHeaders(a.db, { admin: true, stepUp: true, origin: a.origin });
  const cookie = await fetch(`${a.origin}/federation/ping`, { headers: admin.headers });
  expect(cookie.status).toBe(401);
  expect(await cookie.text()).toBe(GENERIC);
  expect((await fetch(`${a.origin}/federation/ping`)).status).toBe(401);
});

test("signedFetch reaches the other instance and refuses a revoked peer", async () => {
  const peer = getPeer(b.db, a.instanceId);
  if (!peer) throw new Error("not paired");
  const res = await signedFetch(b.db, b.home, peer, "/federation/ping?x=1");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, instanceId: a.instanceId });
  expect(getPeer(a.db, b.instanceId)?.lastSeenAt).not.toBeNull();
  expect(revokePeer(b.db, a.instanceId)).toBe(true);
  await expect(signedFetch(b.db, b.home, peer, "/federation/ping")).rejects.toThrow("revoked");
});
