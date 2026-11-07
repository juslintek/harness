import { expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { newReceiver } from "../../../test-support/push-stub";
import { encryptPayload } from "./encrypt";

const b = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ""), "base64url");

// RFC 8291 Appendix A.
const AS_PUBLIC = b(
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
);
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC = b(
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
);
const SALT = b("DGv6ra1nlYgDCS1FRnbzlw");
const AUTH = b("BTBZMqHH6r4Tts7J_aSIgg");
const PLAIN = b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
const EXPECTED = Buffer.concat([
  b(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ),
  b("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"),
]);

test("matches the RFC 8291 appendix A ciphertext exactly", () => {
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: AS_PRIVATE,
      x: AS_PUBLIC.subarray(1, 33).toString("base64url"),
      y: AS_PUBLIC.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const out = encryptPayload(PLAIN, UA_PUBLIC, AUTH, {
    salt: SALT,
    privateKey,
    publicRaw: AS_PUBLIC,
  });
  expect(out.toString("base64url")).toBe(EXPECTED.toString("base64url"));
});

test("a fresh encryption round-trips through the receiver and differs each time", () => {
  const rx = newReceiver();
  const ua = Buffer.from(rx.p256dh, "base64url");
  const auth = Buffer.from(rx.auth, "base64url");
  const one = encryptPayload(Buffer.from("hello"), ua, auth);
  const two = encryptPayload(Buffer.from("hello"), ua, auth);
  expect(rx.decrypt(one)).toBe("hello");
  expect(one.equals(two)).toBe(false);
});

test("a payload over one record is refused", () => {
  const rx = newReceiver();
  const big = Buffer.alloc(4000, 97);
  expect(() =>
    encryptPayload(big, Buffer.from(rx.p256dh, "base64url"), Buffer.from(rx.auth, "base64url")),
  ).toThrow("payload too large");
});
