import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "./admin";

export interface IdTokenExpectation {
  issuer: string;
  audience: string;
  nonce: string;
  now: number;
}

export interface Identity {
  email: string;
  sub: string;
}

const LEEWAY_S = 60;
const MIN_RSA_BYTES = 256;

const jwk = z.object({
  kty: z.string(),
  kid: z.string().optional(),
  use: z.string().optional(),
  alg: z.string().optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
});
type Jwk = z.infer<typeof jwk>;

const header = z.object({ alg: z.string(), kid: z.string().optional() });

// email_verified must be the boolean true: a provider that sends the string "true" or leaves it
// out cannot vouch for the address, and the address is the only thing that links a login to a user.
const claims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  nbf: z.number().optional(),
  nonce: z.string(),
  sub: z.string().min(1),
  email: z.string().min(3),
  email_verified: z.literal(true),
});

// Only these two are accepted, so "none" and the HMAC family never reach the verifier.
const ALGS = { RS256: "RSA", ES256: "EC" } as const;

function decode(part: string | undefined): unknown {
  try {
    return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function usable(key: Jwk, alg: keyof typeof ALGS, kid: string | undefined): boolean {
  if (key.kty !== ALGS[alg]) return false;
  if (key.use !== undefined && key.use !== "sig") return false;
  if (key.alg !== undefined && key.alg !== alg) return false;
  if (kid !== undefined && key.kid !== kid) return false;
  if (alg === "ES256") return key.crv === "P-256";
  return Buffer.from(key.n ?? "", "base64url").length >= MIN_RSA_BYTES;
}

function signatureHolds(key: Jwk, alg: keyof typeof ALGS, data: string, sig: Buffer): boolean {
  try {
    const material: Record<string, string> = Object.fromEntries(
      Object.entries(key).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const publicKey = createPublicKey({ key: material, format: "jwk" });
    const input = Buffer.from(data);
    return alg === "ES256"
      ? verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)
      : verify("sha256", input, publicKey, sig);
  } catch {
    return false;
  }
}

function claimsHold(c: z.infer<typeof claims>, want: IdTokenExpectation): boolean {
  const audiences = typeof c.aud === "string" ? [c.aud] : c.aud;
  const nowS = want.now / 1000;
  return (
    c.iss === want.issuer &&
    audiences.includes(want.audience) &&
    (audiences.length === 1 || c.azp === want.audience) &&
    c.exp + LEEWAY_S > nowS &&
    (c.nbf === undefined || c.nbf - LEEWAY_S <= nowS) &&
    safeEqual(c.nonce, want.nonce)
  );
}

// Returns the verified identity or null; the reason is never reported, so a caller cannot leak
// which check failed.
export function verifyIdToken(
  token: string,
  keys: unknown[],
  want: IdTokenExpectation,
): Identity | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const head = header.safeParse(decode(parts[0]));
  if (!head.success || !(head.data.alg in ALGS)) return null;
  const alg = head.data.alg as keyof typeof ALGS;
  const sig = Buffer.from(parts[2] ?? "", "base64url");
  const signed = keys
    .map((k) => jwk.safeParse(k))
    .flatMap((r) => (r.success && usable(r.data, alg, head.data.kid) ? [r.data] : []))
    .some((k) => signatureHolds(k, alg, `${parts[0]}.${parts[1]}`, sig));
  if (!signed) return null;
  const body = claims.safeParse(decode(parts[1]));
  if (!body.success || !claimsHold(body.data, want)) return null;
  return { email: body.data.email, sub: body.data.sub };
}
