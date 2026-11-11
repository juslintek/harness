import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { listenDeferred, sessionHeaders } from "../../test-support/app-kit";
import { getSecret } from "../agents/api";
import { fingerprint, parsePublicKey, publicKeyB64 } from "./keys";
import { peerOrigin } from "./pairing";
import { getPeer } from "./peers-repo";

interface Node {
  db: Database;
  home: string;
  origin: string;
  instanceId: string;
  stop: () => void;
}

function boot(): Node {
  const home = mkdtempSync(join(tmpdir(), "harness-fed-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  const listener = listenDeferred();
  const origin = `http://localhost:${listener.port}`;
  const rp = { id: "localhost", name: "Harness", origin };
  listener.attach(createApp({ db, home, port: listener.port, rp, instanceId, version: "t" }));
  return { db, home, origin, instanceId, stop: () => void listener.server.stop(true) };
}

async function call(
  node: Node,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${node.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

let a: Node;
let b: Node;
const seen: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(() => {
  a = boot();
  b = boot();
  for (const level of ["log", "error", "warn", "info"] as const) {
    spies.push(
      spyOn(console, level).mockImplementation(
        (...args) => void seen.push(args.map(String).join(" ")),
      ),
    );
  }
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  a.stop();
  b.stop();
});

function dump(db: Database): string {
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  return tables.map((t) => JSON.stringify(db.query(`SELECT * FROM "${t.name}"`).all())).join("\n");
}

test("two instances pair with an invite and each lists the other", async () => {
  const adminA = await sessionHeaders(a.db, { admin: true, stepUp: true, origin: a.origin });
  const adminB = await sessionHeaders(b.db, { admin: true, stepUp: true, origin: b.origin });
  const invite = await call(a, "POST", "/api/federation/invites", adminA.headers);
  expect(invite.status).toBe(201);
  const { token } = JSON.parse(invite.text) as { token: string };

  const pair = await call(b, "POST", "/api/federation/peers/pair", adminB.headers, {
    url: a.origin,
    token,
  });
  expect(pair.status).toBe(200);

  const listA = JSON.parse((await call(a, "GET", "/api/federation/peers", adminA.headers)).text);
  const listB = JSON.parse((await call(b, "GET", "/api/federation/peers", adminB.headers)).text);
  expect(listA).toMatchObject([{ id: b.instanceId, url: b.origin, revokedAt: null }]);
  expect(listB).toMatchObject([{ id: a.instanceId, url: a.origin, revokedAt: null }]);
  expect(listA[0].fingerprint).toBe(fingerprint(publicKeyB64(b.home)));
  expect(listB[0].fingerprint).toBe(fingerprint(publicKeyB64(a.home)));
  expect(parsePublicKey(publicKeyB64(a.home)).asymmetricKeyType).toBe("ed25519");

  const again = await call(b, "POST", "/api/federation/peers/pair", adminB.headers, {
    url: a.origin,
    token,
  });
  expect(again.status).toBe(400);
});

test("the pair endpoint is public but refuses a wrong token and a malformed body", async () => {
  const body = {
    token: "nope",
    instanceId: "x",
    name: "x",
    url: "https://x.example",
    publicKey: publicKeyB64(b.home),
  };
  const headers = { "content-type": "application/json" };
  expect((await call(a, "POST", "/federation/pair", headers, body)).status).toBe(403);
  expect(
    (await call(a, "POST", "/federation/pair", headers, { ...body, publicKey: "AAAA" })).status,
  ).toBe(400);
  expect(
    (await call(a, "POST", "/federation/pair", headers, { ...body, url: "http://evil.example" }))
      .status,
  ).toBe(400);
});

test("a revoked peer stays listed with revokedAt", async () => {
  const admin = await sessionHeaders(a.db, { admin: true, stepUp: true, origin: a.origin });
  const gone = await call(a, "DELETE", `/api/federation/peers/${b.instanceId}`, admin.headers);
  expect(gone.status).toBe(200);
  const list = JSON.parse((await call(a, "GET", "/api/federation/peers", admin.headers)).text);
  expect(list[0].id).toBe(b.instanceId);
  expect(typeof list[0].revokedAt).toBe("number");
  expect(
    (await call(a, "DELETE", `/api/federation/peers/${b.instanceId}`, admin.headers)).status,
  ).toBe(404);
});

test("only an instance admin reaches the routes and mutations need a fresh step-up", async () => {
  const plain = await sessionHeaders(a.db, { origin: a.origin });
  const noStep = await sessionHeaders(a.db, { admin: true, origin: a.origin });
  for (const [method, path] of [
    ["GET", "/api/federation/peers"],
    ["GET", "/api/federation/identity"],
    ["POST", "/api/federation/invites"],
    ["DELETE", "/api/federation/peers/x"],
  ] as const) {
    expect((await call(a, method, path, plain.headers)).status).toBe(403);
  }
  expect((await call(a, "GET", "/api/federation/identity", noStep.headers)).status).toBe(200);
  for (const [method, path] of [
    ["POST", "/api/federation/invites"],
    ["POST", "/api/federation/peers/pair"],
    ["DELETE", "/api/federation/peers/x"],
  ] as const) {
    const res = await call(a, method, path, noStep.headers, { url: a.origin, token: "t" });
    expect(res.status).toBe(403);
    expect(res.text).toContain("step_up_required");
  }
});

test("the private key is in no response, db row or log", async () => {
  const secret = getSecret("federation.key", a.home) as string;
  expect(secret.length).toBeGreaterThan(20);
  const admin = await sessionHeaders(a.db, { admin: true, stepUp: true, origin: a.origin });
  const texts = [
    (await call(a, "GET", "/api/federation/identity", admin.headers)).text,
    (await call(a, "GET", "/api/federation/peers", admin.headers)).text,
    dump(a.db),
    dump(b.db),
    seen.join("\n"),
  ];
  for (const text of texts) expect(text).not.toContain(secret);
  expect(getSecret("federation.key", b.home)).not.toBe(secret);
});

test("pairing urls: https, or http on a loopback host only", () => {
  expect(peerOrigin("https://nas.example/some/path?q=1")).toBe("https://nas.example");
  expect(peerOrigin("http://localhost:8080")).toBe("http://localhost:8080");
  expect(peerOrigin("http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
  expect(peerOrigin("http://[::1]:1")).toBe("http://[::1]:1");
  for (const bad of [
    "http://nas.example",
    "http://localhost.evil.example",
    "ftp://localhost",
    "https://user:pw@nas.example",
    "not a url",
    "",
  ]) {
    expect(() => peerOrigin(bad)).toThrow();
  }
});

test("pairing an existing instance id with another key is refused and never lifts a revocation", async () => {
  const admin = await sessionHeaders(a.db, { admin: true, stepUp: true, origin: a.origin });
  const original = publicKeyB64(b.home);
  const hijack = publicKeyB64(a.home);
  const headers = { "content-type": "application/json" };
  const invite = async (): Promise<string> =>
    (
      JSON.parse((await call(a, "POST", "/api/federation/invites", admin.headers)).text) as {
        token: string;
      }
    ).token;
  const pairAs = async (publicKey: string): Promise<number> =>
    (
      await call(a, "POST", "/federation/pair", headers, {
        token: await invite(),
        instanceId: b.instanceId,
        name: "again",
        url: b.origin,
        publicKey,
      })
    ).status;

  // b was revoked on a by an earlier test.
  expect(await pairAs(hijack)).toBe(403);
  expect(getPeer(a.db, b.instanceId)?.publicKey).toBe(original);
  expect(await pairAs(original)).toBe(200);
  expect(getPeer(a.db, b.instanceId)?.revokedAt).not.toBeNull();
});
