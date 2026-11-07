import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { publicKeyFromRaw, rawPublicKey } from "./vapid";

const RECORD_SIZE = 4096;
const HEADER_FIXED = 21;
const MAX_PLAIN = RECORD_SIZE - HEADER_FIXED - 65 - 16 - 1;

export interface Ephemeral {
  salt: Buffer;
  privateKey: KeyObject;
  publicRaw: Buffer;
}

function freshEphemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { salt: randomBytes(16), privateKey, publicRaw: rawPublicKey(publicKey) };
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string, len: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), len));

// The sender here and the test receiver both derive the same key and nonce.
export function deriveKeys(
  ecdh: Buffer,
  auth: Buffer,
  uaPublic: Buffer,
  asPublic: Buffer,
  salt: Buffer,
): { cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh, auth, keyInfo, 32));
  return {
    cek: hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16),
    nonce: hkdf(ikm, salt, "Content-Encoding: nonce\0", 12),
  };
}

// RFC 8291 aes128gcm in a single record. `fixed` pins the ephemeral key and salt for the RFC vector.
export function encryptPayload(
  plain: Buffer,
  uaPublic: Buffer,
  auth: Buffer,
  fixed: Ephemeral = freshEphemeral(),
): Buffer {
  if (plain.length > MAX_PLAIN) throw new Error("payload too large");
  const publicKey = publicKeyFromRaw(uaPublic);
  const ecdh = diffieHellman({ privateKey: fixed.privateKey, publicKey });
  const { cek, nonce } = deriveKeys(ecdh, auth, uaPublic, fixed.publicRaw, fixed.salt);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([plain, Buffer.of(2)]);
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER_FIXED);
  fixed.salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = fixed.publicRaw.length;
  return Buffer.concat([header, fixed.publicRaw, sealed]);
}
