import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createInvite } from "./invites";
import { publicKeyB64 } from "./keys";
import { pairProof } from "./pair-proof";
import { acceptPair } from "./pairing";
import { getPeer, insertPeer, listPeers, revokePeer } from "./peers-repo";

function boot() {
  const home = mkdtempSync(join(tmpdir(), "harness-checks-"));
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  return { home, db, id: ensureInstance(db), key: publicKeyB64(home) };
}

const OWN = "https://a.example";

function request(peer: ReturnType<typeof boot>, token: string, url: string) {
  return {
    token,
    instanceId: peer.id,
    name: "p",
    url,
    publicKey: peer.key,
    proof: pairProof(peer.home, "request", token, peer.id, "", url),
  };
}

test("a pair request is refused unless its url is a bare origin, even with a valid proof over it", () => {
  const a = boot();
  const peer = boot();
  const { token } = createInvite(a.db, "u");
  for (const url of [
    "https://m.example/",
    "https://m.example/path",
    "https://m.example?x=1",
    "https://user:pw@m.example",
  ]) {
    expect(acceptPair(a.db, a.home, request(peer, token, url), OWN)).toBe("invalid");
  }
  expect(listPeers(a.db)).toEqual([]);
  expect(acceptPair(a.db, a.home, request(peer, token, "https://m.example"), OWN)).toMatchObject({
    instanceId: a.id,
  });
});

test("a token outside the allowed charset is invalid, not just unknown, and burns nothing", () => {
  const a = boot();
  const peer = boot();
  const { token } = createInvite(a.db, "u");
  for (const bad of [`${token}\n`, `${token} `, `${token}.`]) {
    expect(acceptPair(a.db, a.home, request(peer, bad, "https://m.example"), OWN)).toBe("invalid");
  }
  expect(acceptPair(a.db, a.home, request(peer, token, "https://m.example"), OWN)).toMatchObject({
    instanceId: a.id,
  });
});

test("a revoked peer re-pairing with its own key and url is refused, keeps its row and burns nothing", () => {
  const a = boot();
  const peer = boot();
  const other = boot();
  const url = "https://m.example";
  const first = createInvite(a.db, "u");
  expect(acceptPair(a.db, a.home, request(peer, first.token, url), OWN)).toMatchObject({
    instanceId: a.id,
  });
  revokePeer(a.db, peer.id);
  const before = getPeer(a.db, peer.id);
  expect(before?.revokedAt).not.toBeNull();

  const { token } = createInvite(a.db, "u");
  expect(acceptPair(a.db, a.home, request(peer, token, url), OWN)).toBe("refused");
  expect(getPeer(a.db, peer.id)).toEqual(before);
  expect(insertPeer(a.db, { id: peer.id, name: "x", url, publicKey: peer.key, pairedAt: 1 })).toBe(
    false,
  );
  expect(getPeer(a.db, peer.id)).toEqual(before);
  expect(acceptPair(a.db, a.home, request(other, token, "https://o.example"), OWN)).toMatchObject({
    instanceId: a.id,
  });
});
