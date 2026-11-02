import { afterEach, expect, test } from "bun:test";
import { createBreaker, defaultLimits } from "./breaker";

afterEach(() => {
  delete process.env.HARNESS_BREAKER_EVENTS_PER_MIN;
  delete process.env.HARNESS_BREAKER_MAX_TOKENS;
});

test("trips on the event after the per-minute limit", () => {
  const breaker = createBreaker({ maxEventsPerMinute: 3, maxTokens: 1e9 });
  const verdicts = [1, 2, 3, 4].map(() => breaker.record({ kind: "message" }));
  expect(verdicts).toEqual(["ok", "ok", "ok", "trip"]);
});

test("events older than a minute leave the window", () => {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const breaker = createBreaker({ maxEventsPerMinute: 2, maxTokens: 1e9 });
    breaker.record({ kind: "message" });
    breaker.record({ kind: "message" });
    now += 60_001;
    expect(breaker.record({ kind: "message" })).toBe("ok");
  } finally {
    Date.now = real;
  }
});

test("sums input, output and cache tokens of usage events only", () => {
  const breaker = createBreaker({ maxEventsPerMinute: 1000, maxTokens: 100 });
  const usage = { kind: "usage" as const, inputTokens: 30, outputTokens: 30, cacheReadTokens: 30 };
  expect(breaker.record(usage)).toBe("ok");
  expect(breaker.record({ kind: "message", inputTokens: 999 })).toBe("ok");
  expect(breaker.record({ kind: "usage", cacheWriteTokens: 11 })).toBe("trip");
});

test("progress tokens count toward the cap", () => {
  const breaker = createBreaker({ maxEventsPerMinute: 1000, maxTokens: 100 });
  expect(breaker.addTokens(60)).toBe("ok");
  expect(breaker.addTokens(41)).toBe("trip");
});

test("defaults and env overrides", () => {
  expect(defaultLimits()).toEqual({ maxEventsPerMinute: 300, maxTokens: 20_000_000 });
  process.env.HARNESS_BREAKER_EVENTS_PER_MIN = "7";
  process.env.HARNESS_BREAKER_MAX_TOKENS = "9";
  expect(defaultLimits()).toEqual({ maxEventsPerMinute: 7, maxTokens: 9 });
});
