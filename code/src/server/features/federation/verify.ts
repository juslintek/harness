import type { Database } from "bun:sqlite";
import { verify } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { ensureInstance } from "../../db/db";
import { parsePublicKey } from "./keys";
import { getPeer, touchPeer } from "./peers-repo";
import { canonicalString, sha256Hex } from "./sign";

export const MAX_BODY_BYTES: number = 1024 * 1024;
const WINDOW_MS = 5 * 60_000;
const NONCE_TTL_MS = 10 * 60_000;

export interface PeerEnv {
  Variables: { peerId: string; rawBody: Uint8Array };
}

export interface VerifyDeps {
  now?: () => number;
}

// Every refusal looks the same so a caller cannot tell which check failed.
const unauthorized = (c: Context): Response => c.json({ error: "unauthorized" }, 401);

async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES || !req.body)
    return declared > MAX_BODY_BYTES ? null : new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function signatureHolds(publicKey: string, text: string, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(text),
      parsePublicKey(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

// The nonce is recorded only after the signature checked out, so strangers cannot fill the table.
function burnNonce(db: Database, nonce: string, now: number): boolean {
  db.run("DELETE FROM fed_nonces WHERE at < ?", [now - NONCE_TTL_MS]);
  return (
    db.run("INSERT INTO fed_nonces (nonce, at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING", [
      nonce,
      now,
    ]).changes === 1
  );
}

export function requirePeer(db: Database, deps: VerifyDeps = {}): MiddlewareHandler<PeerEnv> {
  const clock = deps.now ?? Date.now;
  return async function requireSignedPeer(c, next) {
    const h = (name: string): string => c.req.header(name) ?? "";
    const [instance, timestamp, nonce, signature] = [
      h("x-harness-instance"),
      h("x-harness-timestamp"),
      h("x-harness-nonce"),
      h("x-harness-signature"),
    ];
    const now = clock();
    const peer = getPeer(db, instance);
    const fresh = /^\d{1,15}$/.test(timestamp) && Math.abs(now - Number(timestamp)) <= WINDOW_MS;
    if (!peer || peer.revokedAt !== null || !fresh || !nonce || nonce.length > 100) {
      return unauthorized(c);
    }
    const body = await readCapped(c.req.raw);
    if (body === null) return c.json({ error: "payload too large" }, 413);
    const url = new URL(c.req.url);
    const text = canonicalString(
      c.req.method,
      url.pathname + url.search,
      timestamp,
      nonce,
      sha256Hex(body),
      peer.id,
      ensureInstance(db),
    );
    if (!signatureHolds(peer.publicKey, text, signature) || !burnNonce(db, nonce, now)) {
      return unauthorized(c);
    }
    touchPeer(db, peer.id, now);
    c.set("peerId", peer.id);
    c.set("rawBody", body);
    await next();
  };
}
