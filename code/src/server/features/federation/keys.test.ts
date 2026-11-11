import { expect, test } from "bun:test";
import { sign, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSecret } from "../agents/api";
import { fingerprint, instanceKeys, parsePublicKey, publicKeyB64 } from "./keys";

test("the key pair is created once, persists and signs verifiably", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-keys-"));
  expect(getSecret("federation.key", home)).toBeUndefined();
  const first = instanceKeys(home);
  expect(getSecret("federation.key", home)).toBeString();
  const second = instanceKeys(home);
  const message = Buffer.from("payload");
  expect(verify(null, message, second.publicKey, sign(null, message, first.privateKey))).toBe(true);
  const pub = publicKeyB64(home);
  expect(verify(null, message, parsePublicKey(pub), sign(null, message, first.privateKey))).toBe(
    true,
  );
  expect(fingerprint(pub)).toMatch(/^[0-9a-f]{16}$/);
});

test("a key that is not Ed25519 SPKI is rejected", () => {
  expect(() => parsePublicKey("AAAA")).toThrow();
});
