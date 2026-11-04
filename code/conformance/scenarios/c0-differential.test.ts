import { expect, test } from "bun:test";
import { compare } from "../differential";
import { diff, normalizer } from "../kit/normalize";

test("C0-differential-normalizer [phase:0] [slice:kit]", () => {
  const norm = normalizer();
  const first = "0190c0de-0000-7000-8000-000000000001";
  const second = "0190c0de-0000-7000-8000-000000000002";
  const input = {
    id: first,
    at: 1_762_000_000_000,
    small: 42,
    t: "A".repeat(43),
    ref: `run:${first}`,
  };
  expect(norm(input)).toEqual({
    id: "<id1>",
    at: "<ts>",
    small: 42,
    t: "<secret>",
    ref: "run:<id1>",
  });
  expect(norm([second, first])).toEqual(["<id2>", "<id1>"]);
});

test("C0-differential-token-shape [phase:0] [slice:kit]", () => {
  const norm = normalizer();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  expect(token).toHaveLength(43);
  expect(norm(token)).toBe("<secret>");
  const word = "a".repeat(44);
  const path = "/some/long/path/with-dashes_and_underscores/that-runs-fifty-chars".slice(0, 50);
  expect(norm(word)).toBe(word);
  expect(norm(path)).toBe(path);
});

test("C0-differential-diff[phase:0] [slice:kit]", () => {
  expect(diff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  expect(diff({ a: 1, b: 2 }, { a: 1, c: 2 })).toEqual([
    "$.b: only in first",
    "$.c: only in second",
  ]);
  expect(diff({ a: [1, 2] }, { a: [1] })).toEqual(["$.a: length 2 vs 1"]);
  expect(diff({ a: null }, { a: 0 })).toEqual(["$.a: null vs 0"]);
});

test("C0-differential-self [phase:0] [slice:kit] [race:ws-vs-run]", async () => {
  expect(await compare("ts", "ts")).toEqual([]);
});
