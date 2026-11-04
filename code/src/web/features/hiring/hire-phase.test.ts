import { expect, test } from "bun:test";
import { hirePhase } from "./hire-phase";

test("score forms show only while scoring and the decision panel only while deciding", () => {
  expect(hirePhase("scoring")).toEqual({ scoring: true, deciding: false });
  expect(hirePhase("deciding")).toEqual({ scoring: false, deciding: true });
  for (const status of ["interviewing", "followups", "answering"] as const) {
    expect(hirePhase(status)).toEqual({ scoring: false, deciding: false });
  }
});
