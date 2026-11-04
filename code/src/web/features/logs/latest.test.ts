import { expect, test } from "bun:test";
import { latestGuard } from "./latest";

test("only the newest request stays current", () => {
  const next = latestGuard();
  const first = next();
  expect(first()).toBe(true);
  const second = next();
  expect(first()).toBe(false);
  expect(second()).toBe(true);
});
