import type { NewEvent } from "../logs/api";
import { asObj, type LineContext, num, type ParsedLine } from "./claude-tail";
import type { QuotaInput } from "./quota";

function windowQuota(name: string, w: unknown, ts: number): QuotaInput | null {
  const o = asObj(w);
  if (!o || typeof o.used_percent !== "number") return null;
  return {
    provider: "codex",
    window: name,
    usedPercent: o.used_percent,
    // Codex writes epoch seconds; the harness stores epoch ms.
    resetsAt: typeof o.resets_at === "number" ? o.resets_at * 1000 : null,
    source: "tail",
    ...(Number.isNaN(ts) ? {} : { ts }),
  };
}

export function parseCodexLine(line: string, offset: number, ctx: LineContext): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {};
  }
  const top = asObj(raw);
  const payload = asObj(top?.payload);
  if (top?.type !== "event_msg" || payload?.type !== "token_count") return {};
  const ts = typeof top.timestamp === "string" ? Date.parse(top.timestamp) : Number.NaN;
  const quotas: QuotaInput[] = [];
  const limits = asObj(payload.rate_limits);
  for (const name of ["primary", "secondary"]) {
    const q = windowQuota(name, limits?.[name], ts);
    if (q) quotas.push(q);
  }
  const last = asObj(asObj(payload.info)?.last_token_usage);
  if (!last) return { quotas };
  const cached = num(last.cached_input_tokens);
  const event: NewEvent = {
    kind: "usage",
    agent: "codex",
    operation: "chat",
    conversationId: ctx.sessionId,
    // Codex counts cached tokens inside input_tokens; split them so the sum is not doubled.
    inputTokens: Math.max(0, num(last.input_tokens) - cached),
    outputTokens: num(last.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: num(last.cache_write_input_tokens),
    reasoningTokens: num(last.reasoning_output_tokens),
    source: "tail",
    dedupeKey: `codex:${ctx.file}:${offset}`,
    ...(Number.isNaN(ts) ? {} : { ts }),
  };
  return { event, quotas };
}
