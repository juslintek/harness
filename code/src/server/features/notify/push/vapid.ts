import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { getSecret, setSecret } from "../../agents/api";

const b64 = (buf: Buffer): string => buf.toString("base64url");
const JWT_LIFETIME_S = 12 * 3600 - 60;

// Raw uncompressed P-256 point: 0x04 || x || y, the form push services and browsers exchange.
export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.of(4),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("invalid public key");
  const x = b64(raw.subarray(1, 33));
  const y = b64(raw.subarray(33));
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
}

function privateKeyFromRaw(d: Buffer, publicRaw: Buffer): KeyObject {
  const x = b64(publicRaw.subarray(1, 33));
  const y = b64(publicRaw.subarray(33));
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", x, y, d: b64(d) }, format: "jwk" });
}

function loadPair(home: string): { priv: Buffer; pub: Buffer } | null {
  const priv = getSecret("vapid.private", home);
  const pub = getSecret("vapid.public", home);
  if (!priv || !pub) return null;
  return { priv: Buffer.from(priv, "base64url"), pub: Buffer.from(pub, "base64url") };
}

// The pair is created on first use; both halves are stored so the public key needs no recompute.
function ensurePair(home: string): { priv: Buffer; pub: Buffer } {
  const existing = loadPair(home);
  if (existing) return existing;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const priv = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const pub = rawPublicKey(publicKey);
  setSecret("vapid.private", b64(priv), home);
  setSecret("vapid.public", b64(pub), home);
  return { priv, pub };
}

export function vapidPublicKey(home: string): string {
  return b64(ensurePair(home).pub);
}

// RFC 8292 header value. `aud` is the push service origin, so a token for one service is useless
// at another.
export function vapidHeader(
  home: string,
  endpoint: string,
  subject: string,
  nowMs: number,
): string {
  const { priv, pub } = ensurePair(home);
  const aud = new URL(endpoint).origin;
  const claims = { aud, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: subject };
  const part = (o: object): string => b64(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  const sig = sign("sha256", Buffer.from(unsigned), {
    key: privateKeyFromRaw(priv, pub),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${b64(sig)}, k=${b64(pub)}`;
}
