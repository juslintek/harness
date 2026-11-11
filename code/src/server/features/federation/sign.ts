import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

export interface SignParts {
  instance: string;
  // The instance the request is addressed to; signed so it cannot be replayed to a third peer.
  audience: string;
  method: string;
  pathWithQuery: string;
  body: Uint8Array | string;
  timestamp?: number;
  nonce?: string;
}

export interface SignedHeaders {
  instance: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export const sha256Hex = (body: Uint8Array | string): string =>
  createHash("sha256").update(body).digest("hex");

export function canonicalString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  nonce: string,
  bodySha256Hex: string,
  audience: string,
): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${bodySha256Hex}\n${audience}`;
}

export function signRequest(privateKeyB64: string, parts: SignParts): SignedHeaders {
  const timestamp = String(parts.timestamp ?? Date.now());
  const nonce = parts.nonce ?? randomBytes(16).toString("base64url");
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const text = canonicalString(
    parts.method,
    parts.pathWithQuery,
    timestamp,
    nonce,
    sha256Hex(parts.body),
    parts.audience,
  );
  return {
    instance: parts.instance,
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(text), key).toString("base64url"),
  };
}
