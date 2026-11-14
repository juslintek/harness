import { expect, test } from "bun:test";
import { failureText } from "./move";

const handleOf = (id: string): string => (id === "m1" ? "ada" : "unknown");

test("each refusal is named in plain words", () => {
  expect(failureText({ ok: false, reason: "held", holderId: "m1" }, handleOf)).toContain("@ada");
  expect(failureText({ ok: false, reason: "deps_open", open: [3, 5] }, handleOf)).toContain(
    "#3, #5",
  );
  expect(failureText({ ok: false, reason: "children_open", open: [8] }, handleOf)).toContain("#8");
  expect(failureText({ ok: false, reason: "not_found" }, handleOf)).toContain("not available");
});
