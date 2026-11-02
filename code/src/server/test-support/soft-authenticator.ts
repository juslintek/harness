import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

// No node: imports on purpose: the browser bundle of the app tests reuses this file.

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const textEncoder = new TextEncoder();

function toB64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64u(text: string): Uint8Array {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 256) return Uint8Array.of((major << 5) | 24, value);
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}

function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  const entries = [...value].flatMap(([key, item]) => [cbor(key), cbor(item)]);
  return concat(head(5, value.size), ...entries);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function derInt(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start++;
  const body = raw.slice(start);
  const padded = (body[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), body) : body;
  return concat(Uint8Array.of(0x02, padded.length), padded);
}

// WebCrypto returns r||s; WebAuthn wants an ASN.1 DER SEQUENCE of two integers.
function derSignature(raw: Uint8Array): Uint8Array {
  const body = concat(derInt(raw.slice(0, 32)), derInt(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

interface StoredCredential {
  id: Uint8Array;
  privateKey: CryptoKey;
  userHandle: string;
  counter: number;
}

export interface SoftAuthenticator {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    opts?: { userVerified?: boolean },
  ): Promise<AuthenticationResponseJSON>;
}

interface Rp {
  id: string;
  origin: string;
}

function clientData(rp: Rp, type: string, challenge: string): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({ type, challenge, origin: rp.origin, crossOrigin: false }),
  );
}

async function authData(
  rp: Rp,
  flags: number,
  counter: number,
  attested?: Uint8Array,
): Promise<Uint8Array> {
  const rpIdHash = await sha256(textEncoder.encode(rp.id));
  return concat(rpIdHash, Uint8Array.of(flags), u32(counter), attested ?? new Uint8Array());
}

async function attest(
  rp: Rp,
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<{ stored: StoredCredential; response: RegistrationResponseJSON }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const id = crypto.getRandomValues(new Uint8Array(16));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = new Map<Cbor, Cbor>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, fromB64u(jwk.x ?? "")],
    [-3, fromB64u(jwk.y ?? "")],
  ]);
  const attested = concat(
    new Uint8Array(16),
    Uint8Array.of(id.length >> 8, id.length & 0xff),
    id,
    cbor(cose),
  );
  const data = await authData(rp, FLAG_UP | FLAG_UV | FLAG_AT, 0, attested);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", data],
    ]),
  );
  return {
    stored: { id, privateKey: pair.privateKey, userHandle: options.user.id, counter: 0 },
    response: {
      id: toB64u(id),
      rawId: toB64u(id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: toB64u(clientData(rp, "webauthn.create", options.challenge)),
        attestationObject: toB64u(attestationObject),
        transports: ["internal"],
      },
    },
  };
}

async function assert(
  rp: Rp,
  credential: StoredCredential,
  options: PublicKeyCredentialRequestOptionsJSON,
  userVerified: boolean,
): Promise<AuthenticationResponseJSON> {
  credential.counter += 1;
  const data = await authData(rp, userVerified ? FLAG_UP | FLAG_UV : FLAG_UP, credential.counter);
  const client = clientData(rp, "webauthn.get", options.challenge);
  const signed = concat(data, await sha256(client));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      credential.privateKey,
      signed as BufferSource,
    ),
  );
  return {
    id: toB64u(credential.id),
    rawId: toB64u(credential.id),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: toB64u(client),
      authenticatorData: toB64u(data),
      signature: toB64u(derSignature(raw)),
      userHandle: credential.userHandle,
    },
  };
}

export function createSoftAuthenticator(rp: Rp): SoftAuthenticator {
  const credentials = new Map<string, StoredCredential>();
  return {
    async create(options) {
      const { stored, response } = await attest(rp, options);
      credentials.set(response.id, stored);
      return response;
    },
    get(options, opts) {
      const allowed = options.allowCredentials?.map((entry) => entry.id) ?? [];
      const candidates = allowed.length > 0 ? allowed : [...credentials.keys()].reverse();
      const key = candidates.find((id) => credentials.has(id));
      const credential = key === undefined ? undefined : credentials.get(key);
      if (!credential) return Promise.reject(new Error("no matching credential"));
      return assert(rp, credential, options, opts?.userVerified ?? true);
    },
  };
}
