import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sign } from "./sign";

test("sign matches a known vector", () => {
  expect(sign("s3cret", 1700000000, '{"a":1}')).toBe(
    "1698a50bc74d1ff1db85c4e0a5297c2ad9fdba245d5737cdb789e4cc6e098940",
  );
});

test("a receiver recomputing from the raw body gets the same signature", () => {
  const body = JSON.stringify({ kind: "dm", title: "Ünïcode ✓" });
  const expected = createHmac("sha256", "k").update(`42.${body}`).digest("hex");
  expect(sign("k", 42, body)).toBe(expected);
});

test("another secret, timestamp or body changes the signature", () => {
  const base = sign("k", 42, "x");
  expect(sign("k2", 42, "x")).not.toBe(base);
  expect(sign("k", 43, "x")).not.toBe(base);
  expect(sign("k", 42, "y")).not.toBe(base);
});
