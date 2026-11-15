function assertNoPipe(...parts: string[]): void {
  for (const part of parts) {
    if (part.includes("|")) {
      throw new Error(`Domain parameter contains forbidden pipe delimiter: ${part}`);
    }
  }
}

export function createMobileBearerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `hmob_${Buffer.from(bytes).toString("base64url")}`;
}

export function createChallengeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function enrollPayload(rpOrigin: string, challengeId: string, nonce: string): string {
  assertNoPipe(rpOrigin, challengeId, nonce);
  return `harness-mobile-enroll-v1|${rpOrigin}|${challengeId}|${nonce}`;
}

export function pairPayload(rpOrigin: string, challengeId: string, nonce: string): string {
  assertNoPipe(rpOrigin, challengeId, nonce);
  return `harness-mobile-pair-v1|${rpOrigin}|${challengeId}|${nonce}`;
}

export function stepUpPayload(
  rpOrigin: string,
  sessionId: string,
  challengeId: string,
  nonce: string,
): string {
  assertNoPipe(rpOrigin, sessionId, challengeId, nonce);
  return `harness-mobile-stepup-v1|${rpOrigin}|${sessionId}|${challengeId}|${nonce}`;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export async function verifyP256Signature(
  publicKeySpki: string,
  signature: string,
  payload: string,
): Promise<boolean> {
  if (!BASE64URL_RE.test(publicKeySpki) || !BASE64URL_RE.test(signature)) return false;
  const keyBytes = Buffer.from(publicKeySpki, "base64url");
  if (keyBytes.length < 65 || keyBytes.length > 160) return false;
  const sigBytes = Buffer.from(signature, "base64url");
  if (sigBytes.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "spki",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      sigBytes,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
