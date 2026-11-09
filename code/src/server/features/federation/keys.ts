import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { getSecret, setSecret } from "../agents/api";

const SECRET = "federation.key";

interface InstanceKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

// The private key lives only in secrets.json; the public half is derived from it on every call so
// it is never stored twice.
export function instanceKeys(home: string): InstanceKeys {
  let stored = getSecret(SECRET, home);
  if (stored === undefined) {
    const { privateKey } = generateKeyPairSync("ed25519");
    stored = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    setSecret(SECRET, stored, home);
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(stored, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function publicKeyB64(home: string): string {
  return instanceKeys(home).publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

// A peer-supplied key must be a real Ed25519 SPKI, or later verification would fail in odd ways.
export function parsePublicKey(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("public key is not Ed25519");
  return key;
}

export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16);
}
