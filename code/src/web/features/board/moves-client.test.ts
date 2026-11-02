import { expect, test } from "bun:test";
import { failureText } from "./moves-client";

const handleOf = (id: string): string => (id === "m1" ? "ada" : "?");

test("failure reasons read as inline text", () => {
  expect(failureText({ ok: false, reason: "held", holderId: "m1" }, handleOf)).toBe("held by @ada");
  expect(failureText({ ok: false, reason: "deps_open", open: [3, 5] }, handleOf)).toBe(
    "waiting on #3, #5",
  );
  expect(failureText({ ok: false, reason: "children_open", open: [7] }, handleOf)).toBe(
    "subtasks open: #7",
  );
});
