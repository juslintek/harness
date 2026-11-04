// Records WebAuthn ceremonies and negative vectors for the Zig verifier (zig/src/auth/webauthn.zig).
//
// Run from the repo root with code/node_modules installed:
//   bun zig/tools/record-webauthn-fixtures.ts
//
// Registration options, the stored public_key blob and the passkeys row come from the real TS
// stack (passkeys.ts on an in-memory database). Every vector is also run through
// @simplewebauthn/server with the parameters passkeys.ts uses, and that verdict is recorded next
// to the Zig expectation. A vector the Zig verifier must reject has to be rejected by
// simplewebauthn too, unless it carries a `divergence` note.
//
// WebCrypto cannot be seeded, so the keys differ on every run and a re-record changes the file.
// The committed JSON is the reference, not this script's output.
import { writeFileSync } from "node:fs";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "../../code/node_modules/@simplewebauthn/server/esm/index.js";
import { migrate, openDb } from "../../code/src/server/db/db";
import { migrations } from "../../code/src/server/db/migrations";
import {
  finishRegistration,
  loginOptions,
  type Rp,
  registrationOptions,
  stepUpOptions,
} from "../../code/src/server/features/auth/api";
import { createUser } from "../../code/src/server/features/auth/users";

const rp: Rp = { id: "localhost", name: "Harness", origin: "http://localhost:4100" };
const out = new URL("../src/auth/fixtures/webauthn.json", import.meta.url);

type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor> | Raw;
class Raw {
  constructor(readonly bytes: Uint8Array) {}
}

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64u = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));
const hex = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text.replaceAll(" ", ""), "hex"));

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of((major << 5) | 26, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function cbor(value: Cbor): Uint8Array {
  if (value instanceof Raw) return value.bytes;
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "boolean") return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = enc.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cbor));
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function u32(n: number): Uint8Array {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function derInt(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start++;
  const body = raw.slice(start);
  const padded = (body[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), body) : body;
  return concat(Uint8Array.of(0x02, padded.length), padded);
}

function derSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const body = concat(derInt(raw.slice(0, half)), derInt(raw.slice(half)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

type AlgName = "es256" | "es384" | "eddsa" | "rs256" | "mldsa44";
const coseAlg: Record<AlgName, number> = {
  es256: -7,
  es384: -35,
  eddsa: -8,
  rs256: -257,
  mldsa44: -48,
};

interface Flaws {
  up?: boolean;
  uv?: boolean;
  be?: boolean;
  bs?: boolean;
  rpId?: string;
  origin?: string;
  clientType?: string;
  challenge?: string;
  counter?: number;
  badSignature?: boolean;
  signWith?: Device;
  clientExtra?: Record<string, unknown>;
  clientData?: (bytes: Uint8Array) => Uint8Array;
  authData?: (bytes: Uint8Array) => Uint8Array;
  attObj?: (bytes: Uint8Array) => Uint8Array;
  fmt?: string;
  attStmt?: Map<Cbor, Cbor>;
  packedSelf?: boolean;
  credId?: Uint8Array;
  omitAttested?: boolean;
  response?: (json: Record<string, unknown>) => Record<string, unknown>;
}

class Device {
  counter = 0;
  constructor(
    readonly alg: AlgName,
    readonly id: Uint8Array,
    readonly privateKey: CryptoKey,
    readonly cose: Map<Cbor, Cbor>,
  ) {}

  static async make(alg: AlgName, idLength = 16): Promise<Device> {
    const id = crypto.getRandomValues(new Uint8Array(idLength));
    let pair: CryptoKeyPair;
    let cose: Map<Cbor, Cbor>;
    if (alg === "es256" || alg === "es384") {
      const curve = alg === "es256" ? "P-256" : "P-384";
      pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, coseAlg[alg]],
        [-1, alg === "es256" ? 1 : 2],
        [-2, unb64u(jwk.x ?? "")],
        [-3, unb64u(jwk.y ?? "")],
      ]);
    } else if (alg === "eddsa") {
      pair = (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      cose = new Map<Cbor, Cbor>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, unb64u(jwk.x ?? "")],
      ]);
    } else if (alg === "rs256") {
      pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: Uint8Array.of(1, 0, 1),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      cose = new Map<Cbor, Cbor>([
        [1, 3],
        [3, -257],
        [-1, unb64u(jwk.n ?? "")],
        [-2, unb64u(jwk.e ?? "")],
      ]);
    } else {
      pair = (await crypto.subtle.generateKey("ML-DSA-44", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
        pub?: string;
      };
      cose = new Map<Cbor, Cbor>([
        [1, 7],
        [3, -48],
        [-1, unb64u(jwk.pub ?? "")],
      ]);
    }
    return new Device(alg, id, pair.privateKey, cose);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const key = this.privateKey;
    const buf = data as BufferSource;
    switch (this.alg) {
      case "es256":
        return derSignature(
          new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf)),
        );
      case "es384":
        return derSignature(
          new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, key, buf)),
        );
      case "eddsa":
        return new Uint8Array(await crypto.subtle.sign("Ed25519", key, buf));
      case "rs256":
        return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, buf));
      case "mldsa44":
        return new Uint8Array(await crypto.subtle.sign("ML-DSA-44", key, buf));
    }
  }

  private async authData(flaws: Flaws, flagsBase: number, counter: number, attested?: Uint8Array) {
    let flags = flagsBase;
    const set = (bit: number, on: boolean | undefined) => {
      if (on === true) flags |= bit;
      if (on === false) flags &= ~bit;
    };
    set(0x01, flaws.up);
    set(0x04, flaws.uv);
    set(0x08, flaws.be);
    set(0x10, flaws.bs);
    const hash = await sha256(enc.encode(flaws.rpId ?? rp.id));
    const data = concat(hash, Uint8Array.of(flags), u32(counter), attested ?? new Uint8Array());
    return flaws.authData ? flaws.authData(data) : data;
  }

  private clientData(flaws: Flaws, type: string, challenge: string): Uint8Array {
    const base = {
      type: flaws.clientType ?? type,
      challenge: flaws.challenge ?? challenge,
      origin: flaws.origin ?? rp.origin,
      crossOrigin: false,
      ...flaws.clientExtra,
    };
    const bytes = enc.encode(JSON.stringify(base));
    return flaws.clientData ? flaws.clientData(bytes) : bytes;
  }

  async create(options: { challenge: string }, flaws: Flaws = {}) {
    const credId = flaws.credId ?? this.id;
    const attested = flaws.omitAttested
      ? undefined
      : concat(
          new Uint8Array(16),
          Uint8Array.of(credId.length >> 8, credId.length & 0xff),
          credId,
          cbor(this.cose),
        );
    const flagsBase = 0x01 | 0x04 | (flaws.omitAttested ? 0 : 0x40);
    const data = await this.authData(flaws, flagsBase, 0, attested);
    const client = this.clientData(flaws, "webauthn.create", options.challenge);
    let attStmt = flaws.attStmt ?? new Map<Cbor, Cbor>();
    if (flaws.packedSelf) {
      const sig = await this.sign(concat(data, await sha256(client)));
      attStmt = new Map<Cbor, Cbor>([
        ["alg", coseAlg[this.alg]],
        ["sig", sig],
      ]);
    }
    const object = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", flaws.fmt ?? (flaws.packedSelf ? "packed" : "none")],
        ["attStmt", attStmt],
        ["authData", data],
      ]),
    );
    const finalObject = flaws.attObj ? flaws.attObj(object) : object;
    const json = {
      id: b64u(credId),
      rawId: b64u(credId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(client),
        attestationObject: b64u(finalObject),
        transports: ["internal"],
      },
    };
    return flaws.response ? flaws.response(json) : json;
  }

  async get(options: { challenge: string }, flaws: Flaws = {}) {
    this.counter = flaws.counter ?? this.counter + 1;
    const data = await this.authData(flaws, 0x01 | 0x04, this.counter);
    const client = this.clientData(flaws, "webauthn.get", options.challenge);
    const signer = flaws.signWith ?? this;
    let signature = await signer.sign(concat(data, await sha256(client)));
    if (flaws.badSignature) {
      signature = signature.slice();
      signature[signature.length - 1] ^= 0x01;
    }
    const json = {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(client),
        authenticatorData: b64u(data),
        signature: b64u(signature),
        userHandle: "ignored-by-verifier",
      },
    };
    return flaws.response ? flaws.response(json) : json;
  }
}

interface Verdict {
  accepted: boolean;
  message?: string;
}

async function tsRegistration(input: RegInput): Promise<Verdict> {
  try {
    const result = await verifyRegistrationResponse({
      response: input.response as never,
      expectedChallenge: input.challenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpId,
      requireUserVerification: input.requireUserVerification,
    });
    return { accepted: result.verified };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function tsAuthentication(input: AuthInput): Promise<Verdict & { newCounter?: number }> {
  try {
    const result = await verifyAuthenticationResponse({
      response: input.response as never,
      expectedChallenge: input.challenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpId,
      requireUserVerification: input.requireUserVerification,
      credential: {
        id: input.response.id as string,
        publicKey: unb64u(input.credential.publicKey),
        counter: input.credential.counter,
      },
    });
    return { accepted: result.verified, newCounter: result.authenticationInfo.newCounter };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

interface RegInput {
  challenge: string;
  origin: string;
  rpId: string;
  requireUserVerification: boolean;
  response: Record<string, unknown>;
}
interface AuthInput extends RegInput {
  credential: { publicKey: string; counter: number };
}

interface Vector {
  name: string;
  kind: "registration" | "authentication";
  alg: string;
  zigError: string | null;
  input: RegInput | AuthInput;
  ts: Verdict;
  divergence?: string;
  expect?: Record<string, unknown>;
}

const vectors: Vector[] = [];
const optionVectors: unknown[] = [];

async function pushRegistration(
  alg: AlgName,
  name: string,
  challenge: string,
  response: Record<string, unknown>,
  zigError: string | null,
  extra: { divergence?: string; expect?: Record<string, unknown>; input?: Partial<RegInput> } = {},
) {
  const input: RegInput = {
    challenge,
    origin: rp.origin,
    rpId: rp.id,
    requireUserVerification: true,
    response,
    ...extra.input,
  };
  const ts = await tsRegistration(input);
  assertAgreement(name, zigError, ts, extra.divergence);
  vectors.push({
    name,
    kind: "registration",
    alg,
    zigError,
    input,
    ts,
    ...(extra.divergence ? { divergence: extra.divergence } : {}),
    ...(extra.expect ? { expect: extra.expect } : {}),
  });
}

async function pushAuthentication(
  alg: AlgName,
  name: string,
  challenge: string,
  response: Record<string, unknown>,
  credential: { publicKey: string; counter: number },
  zigError: string | null,
  extra: { divergence?: string; input?: Partial<AuthInput> } = {},
) {
  const input: AuthInput = {
    challenge,
    origin: rp.origin,
    rpId: rp.id,
    requireUserVerification: false,
    response,
    credential,
    ...extra.input,
  };
  const ts = await tsAuthentication(input);
  assertAgreement(name, zigError, ts, extra.divergence);
  const { newCounter, ...verdict } = ts;
  vectors.push({
    name,
    kind: "authentication",
    alg,
    zigError,
    input,
    ts: verdict,
    ...(extra.divergence ? { divergence: extra.divergence } : {}),
    ...(zigError === null && newCounter !== undefined ? { expect: { newCounter } } : {}),
  });
}

function assertAgreement(name: string, zigError: string | null, ts: Verdict, divergence?: string) {
  if (divergence) return;
  if ((zigError === null) !== ts.accepted) {
    throw new Error(
      `${name}: Zig expects ${zigError ?? "accept"} but simplewebauthn said ${JSON.stringify(ts)}`,
    );
  }
}

const mutate =
  (offset: number, bits = 0x01) =>
  (bytes: Uint8Array) => {
    const copy = bytes.slice();
    copy[offset] ^= bits;
    return copy;
  };

async function fresh(alg: AlgName) {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const user = createUser(db, { email: "ada@example.com", name: "Ada", instanceAdmin: false });
  const device = await Device.make(alg);
  return { db, user, device };
}

type RegOptions = Awaited<ReturnType<typeof registrationOptions>>;

async function recordCeremony(alg: AlgName) {
  const { db, user, device } = await fresh(alg);
  const userRow = { id: user, email: "ada@example.com", name: "Ada" };

  const regOptions = await registrationOptions(db, rp, user);
  optionVectors.push({
    name: `${alg}: registration options, no credentials`,
    kind: "registration",
    input: {
      rp,
      user: userRow,
      exclude: [],
      challenge: regOptions.challenge,
      challengeId: regOptions.challengeId,
    },
    expected: regOptions,
  });
  const regResponse = await device.create(regOptions);
  const done = await finishRegistration(
    db,
    rp,
    user,
    regOptions.challengeId,
    regResponse as never,
    "device",
  );
  if (!done.ok) throw new Error(`${alg}: TS rejected its own ceremony: ${done.reason}`);
  const row = db
    .query<{ id: string; public_key: Uint8Array; counter: number; transports: string | null }, []>(
      "SELECT id, public_key, counter, transports FROM passkeys",
    )
    .get();
  if (!row) throw new Error("no passkeys row");
  const publicKey = b64u(new Uint8Array(row.public_key));
  await pushRegistration(alg, `${alg}: registration`, regOptions.challenge, regResponse, null, {
    expect: {
      credentialId: row.id,
      publicKey,
      counter: row.counter,
      transports: row.transports,
      userVerified: true,
    },
  });

  const second = await registrationOptions(db, rp, user);
  optionVectors.push({
    name: `${alg}: registration options, one existing credential`,
    kind: "registration",
    input: {
      rp,
      user: userRow,
      exclude: [{ id: row.id, transports: row.transports }],
      challenge: second.challenge,
      challengeId: second.challengeId,
    },
    expected: second,
  });

  let stored = { publicKey, counter: row.counter };

  const login1 = await loginOptions(db, rp);
  optionVectors.push({
    name: `${alg}: login options`,
    kind: "login",
    input: { rp, challenge: login1.challenge, challengeId: login1.challengeId },
    expected: login1,
  });
  const a1 = await device.get(login1);
  await pushAuthentication(alg, `${alg}: login, counter 1`, login1.challenge, a1, stored, null);
  stored = { publicKey, counter: 1 };

  const step = await stepUpOptions(db, rp, user);
  optionVectors.push({
    name: `${alg}: step-up options`,
    kind: "step_up",
    input: {
      rp,
      challenge: step.challenge,
      challengeId: step.challengeId,
      allow: [{ id: row.id, transports: row.transports }],
    },
    expected: step,
  });
  const a2 = await device.get(step);
  await pushAuthentication(
    alg,
    `${alg}: step-up with UV required, counter 2`,
    step.challenge,
    a2,
    stored,
    null,
    {
      input: { requireUserVerification: true },
    },
  );
  stored = { publicKey, counter: 2 };

  // Crypto negatives, run for every algorithm.
  const login2 = await loginOptions(db, rp);
  const other = await Device.make(alg);
  other.counter = 2;
  await pushAuthentication(
    alg,
    `${alg}: bad signature`,
    login2.challenge,
    await device.get(login2, { badSignature: true, counter: 3 }),
    stored,
    "SignatureInvalid",
  );
  await pushAuthentication(
    alg,
    `${alg}: signature from another key`,
    login2.challenge,
    await device.get(login2, { signWith: other, counter: 3 }),
    stored,
    "SignatureInvalid",
  );

  return { db, user, device, regOptions, row, stored, publicKey };
}

async function recordEs256Negatives() {
  const { db, user, device, regOptions, stored, publicKey } = await recordCeremony("es256");
  const alg: AlgName = "es256";

  // Registration negatives, one fresh device per vector so each is a first-time credential.
  const reg = async (
    name: string,
    zigError: string | null,
    flaws: Flaws,
    extra: {
      divergence?: string;
      input?: Partial<RegInput>;
      device?: AlgName;
      idLength?: number;
    } = {},
  ) => {
    const options = await registrationOptions(db, rp, user);
    const d = await Device.make(extra.device ?? alg, extra.idLength ?? 16);
    const response = await d.create(options, flaws);
    await pushRegistration(
      alg,
      `es256: registration, ${name}`,
      options.challenge,
      response,
      zigError,
      {
        ...extra,
      },
    );
  };
  await reg(
    "wrong expected challenge",
    "UnexpectedChallenge",
    {},
    { input: { challenge: regOptions.challenge } },
  );
  await reg("challenge in clientData differs", "UnexpectedChallenge", { challenge: "AAAA" });
  await reg("wrong origin", "UnexpectedOrigin", { origin: "http://localhost:4101" });
  await reg("wrong type (webauthn.get)", "UnexpectedClientDataType", {
    clientType: "webauthn.get",
  });
  await reg("wrong rpIdHash", "UnexpectedRpIdHash", { rpId: "example.com" });
  await reg("user not present", "UserNotPresent", { up: false });
  await reg("user not verified", "UserNotVerified", { uv: false });
  await reg(
    "user not verified is fine when not required",
    null,
    { uv: false },
    { input: { requireUserVerification: false } },
  );
  await reg("backed up but not eligible", "InvalidBackupFlags", { be: false, bs: true });
  await reg("backup eligible and backed up", null, { be: true, bs: true });
  await reg("no attested credential data", "NoCredentialId", { omitAttested: true });
  await reg("ES384 key is not offered", "UnsupportedAlgorithm", {}, { device: "es384" });
  await reg("unsupported attestation format", "UnsupportedAttestationFormat", { fmt: "bogus" });
  await reg("none attestation with a statement", "UnexpectedAttestationStatement", {
    attStmt: new Map<Cbor, Cbor>([["x", 1]]),
  });
  await reg("packed self attestation", null, { packedSelf: true });
  await reg(
    "packed with x5c is not verified",
    null,
    {
      fmt: "packed",
      attStmt: new Map<Cbor, Cbor>([
        ["alg", -7],
        ["sig", new Uint8Array(70).fill(7)],
        ["x5c", [new Uint8Array(64).fill(9)]],
      ]),
    },
    {
      divergence:
        "attStmt is ignored for every format (plan 5.4, C9); simplewebauthn verifies packed x5c",
    },
  );
  await reg(
    "fido-u2f statement is not verified",
    null,
    {
      fmt: "fido-u2f",
      attStmt: new Map<Cbor, Cbor>([
        ["sig", new Uint8Array(8)],
        ["x5c", [new Uint8Array(8)]],
      ]),
    },
    {
      divergence:
        "attStmt is ignored for every format (plan 5.4, C9); simplewebauthn verifies fido-u2f",
    },
  );
  await reg("authenticator data with a trailing byte", "InvalidAuthenticatorData", {
    authData: (b) => concat(b, Uint8Array.of(0)),
  });
  await reg("authenticator data under 37 bytes", "InvalidAuthenticatorData", {
    authData: (b) => b.slice(0, 36),
  });
  await reg("attested data cut inside the credential id", "InvalidAuthenticatorData", {
    authData: (b) => b.slice(0, 37 + 16 + 2 + 5),
  });
  await reg(
    "attestation object with a trailing byte",
    "InvalidAttestationObject",
    {
      attObj: (b) => concat(b, Uint8Array.of(0)),
    },
    { divergence: "simplewebauthn decodes the first CBOR item and ignores what follows" },
  );
  await reg("attestation object truncated", "InvalidAttestationObject", {
    attObj: (b) => b.slice(0, b.length - 20),
  });
  await reg("attestation object is not CBOR", "InvalidAttestationObject", {
    attObj: () => enc.encode("not cbor at all"),
  });
  await reg("attestation object with an indefinite-length map", "InvalidAttestationObject", {
    attObj: (b) => concat(Uint8Array.of(0xbf), b.slice(1), Uint8Array.of(0xff)),
  });
  await reg("attestation object declaring a 4 GiB byte string", "InvalidAttestationObject", {
    attObj: () =>
      hex("a3 63 666d74 64 6e6f6e65 67 61747453746d74 a0 68 61757468446174 61 5a ffffffff 00"),
  });
  await reg("attestation object with a tagged value", "InvalidAttestationObject", {
    attObj: () => hex("a1 63 666d74 c1 64 6e6f6e65"),
  });
  await reg("attestation object with a 2^64 map count", "InvalidAttestationObject", {
    attObj: () => hex("bb ffffffffffffffff"),
  });
  await reg(
    "credential id of 1024 bytes",
    "CredentialIdTooLong",
    {},
    {
      idLength: 1024,
      divergence:
        "credentialId is limited to 1023 bytes (WebAuthn L3 7.1); simplewebauthn has no limit",
    },
  );
  await reg("id differs from rawId", "CredentialIdNotBase64Url", {
    response: (j) => ({ ...j, rawId: "AAAA" }),
  });
  await reg("credential type is not public-key", "UnexpectedCredentialType", {
    response: (j) => ({ ...j, type: "password" }),
  });
  await reg("clientDataJSON is not JSON", "InvalidClientData", {
    clientData: () => enc.encode("{nope"),
  });
  await reg("clientDataJSON with a bad tokenBinding status", "InvalidTokenBinding", {
    clientExtra: { tokenBinding: { status: "weird" } },
  });
  await reg("clientDataJSON with a valid tokenBinding", null, {
    clientExtra: { tokenBinding: { status: "supported" } },
  });
  await reg("crossOrigin is not checked at registration", null, {
    clientExtra: { crossOrigin: true },
  });

  // Authentication negatives (es256 only; crypto negatives run for every algorithm above).
  const auth = async (
    name: string,
    zigError: string | null,
    flaws: Flaws,
    extra: {
      divergence?: string;
      input?: Partial<AuthInput>;
      credential?: { publicKey: string; counter: number };
      purpose?: "login" | "step_up";
      keepCounter?: boolean;
    } = {},
  ) => {
    const options =
      extra.purpose === "step_up" ? await stepUpOptions(db, rp, user) : await loginOptions(db, rp);
    const response = await device.get(options, { counter: 3, ...flaws });
    await pushAuthentication(
      alg,
      `es256: authentication, ${name}`,
      options.challenge,
      response,
      extra.credential ?? stored,
      zigError,
      extra,
    );
  };
  await auth(
    "wrong expected challenge",
    "UnexpectedChallenge",
    {},
    { input: { challenge: regOptions.challenge } },
  );
  await auth("challenge in clientData differs", "UnexpectedChallenge", { challenge: "AAAA" });
  await auth("wrong origin", "UnexpectedOrigin", { origin: "http://localhost:4101" });
  await auth("wrong type (webauthn.create)", "UnexpectedClientDataType", {
    clientType: "webauthn.create",
  });
  await auth("wrong rpIdHash", "UnexpectedRpIdHash", { rpId: "example.com" });
  await auth("user not present", "UserNotPresent", { up: false });
  await auth("user not present and not verified", "UserNotPresent", { up: false, uv: false });
  await auth("user not verified, not required (login)", null, { uv: false });
  await auth(
    "user not verified, required (step-up)",
    "UserNotVerified",
    { uv: false },
    { purpose: "step_up", input: { requireUserVerification: true } },
  );
  await auth("backed up but not eligible", "InvalidBackupFlags", { be: false, bs: true });
  await auth("backup eligible and backed up", null, { be: true, bs: true });
  await auth("counter equals the stored counter", "CounterNotIncreased", { counter: 2 });
  await auth("counter below the stored counter", "CounterNotIncreased", { counter: 1 });
  await auth(
    "replayed response: stored counter already advanced",
    "CounterNotIncreased",
    {},
    { credential: { publicKey, counter: 3 } },
  );
  await auth(
    "counter zero on both sides is allowed",
    null,
    { counter: 0 },
    { credential: { publicKey, counter: 0 } },
  );
  await auth("response counter zero, stored counter above zero", "CounterNotIncreased", {
    counter: 0,
  });
  await auth("counter jumps far ahead", null, { counter: 0xffffffff });
  await auth("cross origin without topOrigin passes", null, { clientExtra: { crossOrigin: true } });
  await auth("cross origin with an unexpected topOrigin", "UnexpectedTopOrigin", {
    clientExtra: { crossOrigin: true, topOrigin: "https://evil.example" },
  });
  await auth("topOrigin without crossOrigin", "UnexpectedTopOrigin", {
    clientExtra: { topOrigin: "http://localhost:4100" },
  });
  await auth("tokenBinding notSupported is valid here", null, {
    clientExtra: { tokenBinding: { status: "notSupported" } },
  });
  await auth("tokenBinding not-supported is invalid here", "InvalidTokenBinding", {
    clientExtra: { tokenBinding: { status: "not-supported" } },
  });
  await auth("clientDataJSON with duplicate keys, last wins", null, {
    clientData: (b) => {
      const text = new TextDecoder().decode(b);
      return enc.encode(text.replace("{", '{"type":"webauthn.create",'));
    },
  });
  await auth("authenticator data with a trailing byte", "InvalidAuthenticatorData", {
    authData: (b) => concat(b, Uint8Array.of(0)),
  });
  await auth("authenticator data under 37 bytes", "InvalidAuthenticatorData", {
    authData: (b) => b.slice(0, 36),
  });
  await auth("attested data flag set with nothing behind it", "InvalidAuthenticatorData", {
    authData: mutate(32, 0x40),
  });
  await auth("id differs from rawId", "CredentialIdNotBase64Url", {
    response: (j) => ({ ...j, rawId: "AAAA" }),
  });
  await auth("credential type is not public-key", "UnexpectedCredentialType", {
    response: (j) => ({ ...j, type: "x" }),
  });
  await auth("signature is not base64url", "InvalidEncoding", {
    response: (j) => ({ ...j, response: { ...(j.response as object), signature: "!!!!" } }),
  });
  await auth(
    "signature is DER with trailing bytes",
    "SignatureInvalid",
    {
      response: (j) => {
        const r = j.response as { signature: string };
        return {
          ...j,
          response: { ...r, signature: b64u(concat(unb64u(r.signature), Uint8Array.of(0))) },
        };
      },
    },
    {
      divergence:
        "peculiar ASN.1 parsing may accept trailing bytes; the recorded verdict is informational",
    },
  );
}

// Per-algorithm ceremonies are recorded separately so a failure names the algorithm.
await recordEs256Negatives();
for (const alg of ["eddsa", "rs256", "mldsa44"] as const) await recordCeremony(alg);

writeFileSync(
  out,
  `${JSON.stringify({ rp, generatedBy: "zig/tools/record-webauthn-fixtures.ts", vectors, options: optionVectors })}\n`,
);
console.log(
  `wrote ${vectors.length} vectors and ${optionVectors.length} option sets to ${out.pathname}`,
);
