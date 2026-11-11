import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureInstance } from "../../db/db";
import { DomainError } from "../../route-kit";
import { consumeInvite } from "./invites";
import { fingerprint, parsePublicKey, publicKeyB64 } from "./keys";
import { insertPeer } from "./peers-repo";

class PairError extends DomainError {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PAIR_TIMEOUT_MS = 10_000;

// Plain http would let anyone on the path read the invite token, so it is accepted only for a
// loopback host, where the traffic never leaves the machine (tests and a same-host setup).
// Returns the bare origin: a path or credentials in the url are dropped, never stored.
export function peerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PairError("invalid url");
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new PairError("url must be https");
  }
  if (url.username || url.password) throw new PairError("url must not carry credentials");
  return url.origin;
}

const publicKeyField = z.string().refine((key) => {
  try {
    parsePublicKey(key);
    return true;
  } catch {
    return false;
  }
}, "not an Ed25519 public key");

const pairBody = z.object({
  token: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  url: z.string().max(500),
  publicKey: publicKeyField,
});

const pairAnswer = z.object({
  instanceId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  publicKey: publicKeyField,
});

export interface PairAnswer {
  instanceId: string;
  name: string;
  publicKey: string;
}

const ownName = (instanceId: string): string => `harness-${instanceId.slice(0, 8)}`;

export function identity(db: Database, home: string): PairAnswer & { fingerprint: string } {
  const instanceId = ensureInstance(db);
  const publicKey = publicKeyB64(home);
  return { instanceId, name: ownName(instanceId), publicKey, fingerprint: fingerprint(publicKey) };
}

// The one-time token is the whole proof here, so it is checked and burned in the same transaction
// that stores the peer; a body that does not parse never burns it.
export function acceptPair(
  db: Database,
  home: string,
  body: unknown,
  now: number = Date.now(),
): PairAnswer | "invalid" | "refused" {
  const parsed = pairBody.safeParse(body);
  if (!parsed.success) return "invalid";
  const { token, instanceId, name, url, publicKey } = parsed.data;
  const own = identity(db, home);
  let origin: string;
  try {
    origin = peerOrigin(url);
  } catch {
    return "invalid";
  }
  if (instanceId === own.instanceId) return "invalid";
  const accepted = db.transaction(() => {
    if (!consumeInvite(db, token, now)) return false;
    // A key clash still burns the invite: it was used to claim an id that is not new.
    return insertPeer(db, { id: instanceId, name, url: origin, publicKey, pairedAt: now });
  })();
  return accepted
    ? { instanceId: own.instanceId, name: own.name, publicKey: own.publicKey }
    : "refused";
}

export interface PairDeps {
  ownUrl: string;
  fetch?: typeof fetch;
}

export async function pairWith(
  db: Database,
  home: string,
  target: { url: string; token: string },
  deps: PairDeps,
  now: number = Date.now(),
): Promise<PairAnswer> {
  const origin = peerOrigin(target.url);
  const own = identity(db, home);
  const send = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await send(`${origin}/federation/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: target.token,
        instanceId: own.instanceId,
        name: own.name,
        url: deps.ownUrl,
        publicKey: own.publicKey,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    });
  } catch {
    throw new PairError("peer unreachable");
  }
  if (!res.ok) throw new PairError(`peer refused pairing (${res.status})`);
  const answer = pairAnswer.safeParse(await res.json().catch(() => null));
  if (!answer.success) throw new PairError("peer answered with an invalid body");
  if (answer.data.instanceId === own.instanceId) throw new PairError("cannot pair with itself");
  // The url we dialed is stored, not one the peer claims, so a peer cannot redirect later calls.
  const stored = insertPeer(db, {
    id: answer.data.instanceId,
    name: answer.data.name,
    publicKey: answer.data.publicKey,
    url: origin,
    pairedAt: now,
  });
  if (!stored) throw new PairError("peer id is already paired with a different key");
  return answer.data;
}
