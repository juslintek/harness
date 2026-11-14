import { expect, test } from "bun:test";
import type { HireView } from "@shared/hiring";
import { hirePhase, sortHires, stepsOf, whereIs } from "./hire-phase";

test("score forms show only while scoring and the decision panel only while deciding", () => {
  expect(hirePhase("scoring")).toEqual({ scoring: true, deciding: false });
  expect(hirePhase("deciding")).toEqual({ scoring: false, deciding: true });
  for (const status of ["interviewing", "followups", "answering"] as const) {
    expect(hirePhase(status)).toEqual({ scoring: false, deciding: false });
  }
});

test("follow-ups and answering are one step, and a closed request says Closed", () => {
  expect(whereIs("answering")).toBe("Follow-ups, step 2 of 5");
  expect(whereIs("deciding")).toBe("Decision, step 4 of 5");
  expect(whereIs("hired")).toBe("Closed");
  expect(stepsOf("scoring")?.map((s) => s.state)).toEqual([
    "done",
    "done",
    "current",
    "todo",
    "todo",
  ]);
  expect(stepsOf("hired")?.every((s) => s.state === "done")).toBe(true);
  expect(stepsOf("cancelled")).toBeNull();
});

test("the list puts requests waiting for a decision first, then open, then closed", () => {
  const make = (id: string, status: HireView["status"], createdAt: number): HireView =>
    ({ id, status, createdAt }) as HireView;
  const ids = sortHires([
    make("old-closed", "hired", 1),
    make("new-closed", "rejected", 9),
    make("open", "scoring", 5),
    make("wait", "deciding", 2),
  ]).map((h) => h.id);
  expect(ids).toEqual(["wait", "open", "new-closed", "old-closed"]);
});
