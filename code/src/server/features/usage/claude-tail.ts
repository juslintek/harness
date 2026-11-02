import type { NewEvent } from "../logs/api";
import type { QuotaInput } from "./quota";

export interface LineContext {
  file: string;
  sessionId: string;
}

export interface ParsedLine {
  event?: NewEvent;
  quotas?: QuotaInput[];
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseClaudeLine(line: string, _offset: number, ctx: LineContext): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {};
  }
  const top = asObj(raw);
  const message = asObj(top?.message);
  const usage = asObj(message?.usage);
  if (!top || !message || !usage || typeof message.id !== "string") return {};
  const ts = typeof top.timestamp === "string" ? Date.parse(top.timestamp) : Number.NaN;
  const details = asObj(usage.output_tokens_details);
  const event: NewEvent = {
    kind: "usage",
    agent: "claude",
    operation: "chat",
    conversationId: ctx.sessionId,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    reasoningTokens: num(details?.thinking_tokens),
    source: "tail",
    dedupeKey: `claude:${message.id}`,
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(Number.isNaN(ts) ? {} : { ts }),
  };
  return { event };
}
