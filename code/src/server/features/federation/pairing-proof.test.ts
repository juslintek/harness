import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createInvite } from "./invites";
import { publicKeyB64 } from "./keys";
import { pairProof, pairProofHolds } from "./pair-proof";
import { acceptPair, pairWith } from "./pairing";
import { insertPeer, listPeers } from "./peers-repo";

function boot() {
  const home = mkdtempSync(join(tmpdir(), "harness-proof-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  return { home, db, id: ensureInstance(db), key: publicKeyB64(home) };
}

test("accepting a pairing needs a proof signed by the key it presents", () => {
  const a = boot();
  const m = boot();
  const victim = boot();
  const { token } = createInvite(a.db, "u");
  const body = (proof: string) => ({
    token,
    instanceId: victim.id,
    name: "v",
    url: "https://m.example",
    publicKey: victim.key,
    proof,
  });
  // M knows the victim's id and public key, but only holds its own private key.
  expect(
    acceptPair(
      a.db,
      a.home,
      body(pairProof(m.home, "request", token, victim.id, "", "https://m.example")),
      "https://a.example",
    ),
  ).toBe("invalid");
  expect(acceptPair(a.db, a.home, { ...body("x"), proof: undefined }, "https://a.example")).toBe(
    "invalid",
  );
  expect(listPeers(a.db)).toEqual([]);
  const ok = acceptPair(
    a.db,
    a.home,
    body(pairProof(victim.home, "request", token, victim.id, "", "https://m.example")),
    "https://a.example",
  );
  expect(ok).toMatchObject({ instanceId: a.id });
});

const M = "https://m.example";

test("pairing out refuses an answer without a valid proof for the key it claims", async () => {
  const c = boot();
  const m = boot();
  const victim = boot();
  const answer = (proof: string) => async () =>
    Response.json({ instanceId: victim.id, name: "v", publicKey: victim.key, url: M, proof });
  const target = { url: M, token: "t1" };
  const deps = (proof: string) => ({
    ownUrl: "https://c.example",
    fetch: answer(proof) as unknown as typeof fetch,
  });
  const forged = pairProof(m.home, "answer", "t1", victim.id, c.id, M);
  await expect(pairWith(c.db, c.home, target, deps(forged))).rejects.toThrow("prove");
  // A request proof must not pass as an answer proof.
  const wrongDirection = pairProof(victim.home, "request", "t1", victim.id, c.id, M);
  await expect(pairWith(c.db, c.home, target, deps(wrongDirection))).rejects.toThrow("prove");
  expect(listPeers(c.db)).toEqual([]);
  const real = pairProof(victim.home, "answer", "t1", victim.id, c.id, M);
  expect((await pairWith(c.db, c.home, target, deps(real))).instanceId).toBe(victim.id);
});

test("a public key belongs to one active peer; migration 037 revokes older duplicates", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-uniq-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations.slice(0, 36));
  const row = (id: string, at: number, revoked: number | null) =>
    db.run(
      "INSERT INTO peers (id, name, url, public_key, paired_at, revoked_at) VALUES (?, ?, 'https://x', 'K', ?, ?)",
      [id, id, at, revoked],
    );
  row("old", 1, null);
  row("dup", 2, null);
  row("gone", 3, 5);
  migrate(db, migrations);
  const state = Object.fromEntries(listPeers(db).map((p) => [p.id, p.revokedAt !== null]));
  expect(state).toEqual({ old: false, dup: true, gone: true });
  const other = { name: "n", url: "https://y", publicKey: "K", pairedAt: 9 };
  expect(insertPeer(db, { id: "third", ...other })).toBe(false);
});

test("a relay that swaps the requester's url breaks the request proof", () => {
  const a = boot();
  const c = boot();
  const { token } = createInvite(a.db, "u");
  const signed = pairProof(c.home, "request", token, c.id, "", "https://c.example");
  const body = (url: string) => ({
    token,
    instanceId: c.id,
    name: "c",
    url,
    publicKey: c.key,
    proof: signed,
  });
  expect(acceptPair(a.db, a.home, body("https://m.evil"), "https://a.example")).toBe("invalid");
  expect(listPeers(a.db)).toEqual([]);
  expect(acceptPair(a.db, a.home, body("https://c.example"), "https://a.example")).toMatchObject({
    instanceId: a.id,
  });
});

test("a relay in front of the acceptor is refused: the signed answer names another address", async () => {
  const a = boot();
  const c = boot();
  const { token } = createInvite(a.db, "u");
  // M holds the token, C dials M, and M forwards C's request to A unchanged and relays A's answer.
  const relay = (async (_url: string, init: RequestInit) =>
    Response.json(
      acceptPair(a.db, a.home, JSON.parse(String(init.body)), "https://a.example"),
    )) as unknown as typeof fetch;
  const deps = { ownUrl: "https://c.example", fetch: relay };
  await expect(pairWith(c.db, c.home, { url: "https://m.evil", token }, deps)).rejects.toThrow(
    "different address",
  );
  expect(listPeers(c.db)).toEqual([]);
});

test("pairing with a dialed address that matches the signed answer stores the peer", async () => {
  const a = boot();
  const c = boot();
  const { token } = createInvite(a.db, "u");
  const direct = (async (_url: string, init: RequestInit) =>
    Response.json(
      acceptPair(a.db, a.home, JSON.parse(String(init.body)), "https://a.example"),
    )) as unknown as typeof fetch;
  const deps = { ownUrl: "https://c.example", fetch: direct };
  await pairWith(c.db, c.home, { url: "https://a.example/ignored/path", token }, deps);
  expect(listPeers(c.db)).toMatchObject([{ id: a.id, url: "https://a.example" }]);
  expect(listPeers(a.db)).toMatchObject([{ id: c.id, url: "https://c.example" }]);
});

test("a signature never covers two different field splits", () => {
  const h = boot();
  const url = "https://a.example";
  const sig = pairProof(h.home, "answer", "t", "C_id\nM_id", "x", url);
  // A bare newline join made these two splits the same bytes.
  expect(pairProofHolds(h.key, sig, "answer", "t", "C_id", "M_id\nx", url)).toBe(false);
  expect(pairProofHolds(h.key, sig, "answer", "t", "C_id\nM_id", "x", url)).toBe(true);
});

test("a requester id carrying a newline is refused even with a valid proof", () => {
  const a = boot();
  const c = boot();
  const { token } = createInvite(a.db, "u");
  const id = "C_id\nhttps://m.evil#";
  const url = "https://c.example";
  expect(
    acceptPair(
      a.db,
      a.home,
      {
        token,
        instanceId: id,
        name: "c",
        url,
        publicKey: c.key,
        proof: pairProof(c.home, "request", token, id, "", url),
      },
      "https://a.example",
    ),
  ).toBe("invalid");
  expect(listPeers(a.db)).toEqual([]);
});

test("an answer whose url is not a bare origin is refused before the proof counts", async () => {
  const c = boot();
  const m = boot();
  const url = "https://m.evil#\nhttps://a.example";
  const reply = async () =>
    Response.json({
      instanceId: "A_id",
      name: "a",
      publicKey: m.key,
      url,
      proof: pairProof(m.home, "answer", "t1", "A_id", c.id, url),
    });
  const deps = { ownUrl: "https://c.example", fetch: reply as unknown as typeof fetch };
  await expect(
    pairWith(c.db, c.home, { url: "https://m.evil", token: "t1" }, deps),
  ).rejects.toThrow("different address");
  expect(listPeers(c.db)).toEqual([]);
});

test("an answer without a url is refused, even with a proof over an empty url", async () => {
  const c = boot();
  const m = boot();
  const reply = async () =>
    Response.json({
      instanceId: "A_id",
      name: "a",
      publicKey: m.key,
      proof: pairProof(m.home, "answer", "t1", "A_id", c.id, ""),
    });
  const deps = { ownUrl: "https://c.example", fetch: reply as unknown as typeof fetch };
  await expect(
    pairWith(c.db, c.home, { url: "https://m.evil", token: "t1" }, deps),
  ).rejects.toThrow("invalid body");
  expect(listPeers(c.db)).toEqual([]);
});
