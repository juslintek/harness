import { expect, test } from "bun:test";
import { keptAfterReload, mayDiscard } from "./memory-data";

test("a second reload without edits keeps the first draft", () => {
  const first = keptAfterReload(null, "my draft", "server v1");
  expect(first).toBe("my draft");
  expect(keptAfterReload(first, "server v1", "server v1")).toBe("my draft");
});

test("a draft edited after a reload replaces the kept one", () => {
  expect(keptAfterReload("old draft", "newer draft", "server v2")).toBe("newer draft");
});

test("escape asks before dropping an edited draft", () => {
  const asked: string[] = [];
  expect(mayDiscard(false, () => false)).toBe(true);
  expect(mayDiscard(true, (q) => (asked.push(q), false))).toBe(false);
  expect(mayDiscard(true, () => true)).toBe(true);
  expect(asked).toHaveLength(1);
});
