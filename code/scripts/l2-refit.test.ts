import { expect, test } from "bun:test";
import { bestFit, confusionAt } from "./l2-refit";

test("a higher threshold drops approved escalations and adds misses for denied ones", () => {
  const samples = [
    { destructive: 0.96, approved: true },
    { destructive: 0.97, approved: true },
    { destructive: 0.99, approved: false },
  ];
  expect(confusionAt(samples, 0.95)).toEqual({ threshold: 0.95, wrongEscalations: 2, misses: 0 });
  expect(confusionAt(samples, 0.98)).toEqual({ threshold: 0.98, wrongEscalations: 0, misses: 0 });
  expect(bestFit(samples, 0.95).threshold).toBeGreaterThan(0.97);
  expect(bestFit(samples, 0.95).wrongEscalations).toBe(0);
});
