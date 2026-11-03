import { expect, test } from "bun:test";
import {
  type Difficulty,
  difficulties,
  type Engine,
  SIZE_PRIOR_MINUTES,
  type SizeBucket,
  sizeBuckets,
  type TaskType,
  taskTypes,
} from "./router";

test("every size bucket has a human-minute prior that grows with the bucket", () => {
  const minutes = sizeBuckets.map((bucket: SizeBucket) => SIZE_PRIOR_MINUTES[bucket]);
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  expect(new Set(minutes).size).toBe(sizeBuckets.length);
});

test("the routing vocabulary has no duplicates", () => {
  const types: readonly TaskType[] = taskTypes;
  const levels: readonly Difficulty[] = difficulties;
  const engine: Engine = { runtime: "claude", model: null };
  expect(new Set(types).size).toBe(types.length);
  expect(new Set(levels).size).toBe(levels.length);
  expect(engine.model).toBeNull();
});
