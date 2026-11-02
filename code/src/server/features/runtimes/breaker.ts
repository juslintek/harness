import type { NewEvent } from "../logs/api";

export interface BreakerLimits {
  maxEventsPerMinute: number;
  maxTokens: number;
}

const WINDOW_MS = 60_000;

function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return n > 0 ? n : fallback;
}

export function defaultLimits(): BreakerLimits {
  return {
    maxEventsPerMinute: fromEnv("HARNESS_BREAKER_EVENTS_PER_MIN", 300),
    maxTokens: fromEnv("HARNESS_BREAKER_MAX_TOKENS", 20_000_000),
  };
}

const tokensOf = (e: NewEvent): number =>
  e.kind === "usage"
    ? (e.inputTokens ?? 0) +
      (e.outputTokens ?? 0) +
      (e.cacheReadTokens ?? 0) +
      (e.cacheWriteTokens ?? 0)
    : 0;

export function createBreaker(limits: BreakerLimits): {
  record(e: NewEvent): "ok" | "trip";
  addTokens(n: number): "ok" | "trip";
} {
  const stamps: number[] = [];
  let tokens = 0;
  return {
    addTokens(n) {
      tokens += n;
      return tokens > limits.maxTokens ? "trip" : "ok";
    },
    record(e) {
      const now = Date.now();
      stamps.push(now);
      while (stamps.length > 0 && (stamps[0] as number) <= now - WINDOW_MS) stamps.shift();
      tokens += tokensOf(e);
      return stamps.length > limits.maxEventsPerMinute || tokens > limits.maxTokens ? "trip" : "ok";
    },
  };
}
