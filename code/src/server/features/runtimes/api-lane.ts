import { getApiKey, type Provider } from "../agents/api";
import type { UsageRecord } from "../usage/api";
import type { Adapter, RunContext, RunOutcome } from "./adapter";

const baseUrls: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://127.0.0.1:11434/v1",
  anthropic: "https://api.anthropic.com/v1",
};
// Anthropic requires max_tokens on every request.
const ANTHROPIC_MAX_TOKENS = 8192;

interface Options {
  fetch?: typeof fetch;
  getKey?: (provider: Provider) => Promise<string | null>;
  baseUrls?: Record<string, string>;
}

interface Reply {
  text: string;
  stop: RunOutcome["stopReason"];
  usage: UsageRecord;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageRecord(
  model: string,
  fields: Pick<UsageRecord, "inputTokens" | "outputTokens"> & Partial<UsageRecord>,
): UsageRecord {
  return {
    model,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: null,
    source: "api",
    ...fields,
  };
}

const openAiStops: Record<string, RunOutcome["stopReason"]> = {
  length: "max_tokens",
  content_filter: "refusal",
};

function fromOpenAi(body: Json, model: string): Reply {
  const choice = obj(Array.isArray(body.choices) ? body.choices[0] : null);
  const text = obj(choice.message).content;
  const usage = obj(body.usage);
  const cached = num(obj(usage.prompt_tokens_details).cached_tokens);
  const finish = choice.finish_reason;
  return {
    text: typeof text === "string" ? text : "",
    stop: openAiStops[String(finish)] ?? "end_turn",
    usage: usageRecord(model, {
      inputTokens: Math.max(0, num(usage.prompt_tokens) - cached),
      outputTokens: num(usage.completion_tokens),
      cacheReadTokens: cached,
      reasoningTokens: num(obj(usage.completion_tokens_details).reasoning_tokens),
    }),
  };
}

function fromAnthropic(body: Json, model: string): Reply {
  const blocks = Array.isArray(body.content) ? body.content.map(obj) : [];
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  const usage = obj(body.usage);
  const stop =
    body.stop_reason === "max_tokens" || body.stop_reason === "refusal"
      ? body.stop_reason
      : "end_turn";
  return {
    text,
    stop,
    usage: usageRecord(model, {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
    }),
  };
}

function request(
  provider: string,
  base: string,
  model: string,
  prompt: string,
  key: string | null,
): { url: string; init: RequestInit } {
  const messages = [{ role: "user", content: prompt }];
  if (provider === "anthropic") {
    return {
      url: `${base}/messages`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: ANTHROPIC_MAX_TOKENS, messages }),
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, messages }),
    },
  };
}

function failed(stopReason: RunOutcome["stopReason"], error: string | null): RunOutcome {
  return { stopReason, text: "", usage: [], error, sessionId: null };
}

async function send(
  ctx: RunContext,
  provider: string,
  req: { url: string; init: RequestInit },
  model: string,
  opts: Options,
  scrub: (text: string) => string,
): Promise<RunOutcome> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.idleTimeoutMs)]);
  try {
    const res = await (opts.fetch ?? fetch)(req.url, { ...req.init, signal });
    // The response body is not quoted: error bodies are the likeliest place for a key to leak.
    if (!res.ok) return failed("error", `${provider} answered HTTP ${res.status}`);
    const parse = provider === "anthropic" ? fromAnthropic : fromOpenAi;
    const reply = parse(obj(await res.json()), model);
    if (reply.text.trim() === "" && reply.stop === "end_turn") {
      return failed("error", `${provider} returned an empty response`);
    }
    return { ...failed(reply.stop, null), text: reply.text, usage: [reply.usage] };
  } catch (err) {
    if (ctx.signal.aborted) return failed("cancelled", null);
    if (signal.aborted) return failed("timeout", `no answer within ${ctx.idleTimeoutMs} ms`);
    return failed("error", scrub(err instanceof Error ? err.message : String(err)));
  }
}

async function call(ctx: RunContext, provider: string, opts: Options): Promise<RunOutcome> {
  const base = (opts.baseUrls ?? baseUrls)[provider];
  if (base === undefined) return failed("error", `unknown api provider ${provider}`);
  if (!ctx.model) return failed("error", "api lane needs a model");
  const key = provider === "ollama" ? null : await (opts.getKey ?? getApiKey)(provider as Provider);
  if (provider !== "ollama" && !key) return failed("error", `no api key stored for ${provider}`);
  // The key is scrubbed from every message; providers sometimes echo it in errors.
  const scrub = (text: string): string => (key ? text.split(key).join("[redacted]") : text);
  const req = request(provider, base, ctx.model, ctx.prompt, key);
  return send(ctx, provider, req, ctx.model, opts, scrub);
}

export function createApiAdapter(opts: Options): Adapter {
  return async (ctx) => {
    const provider = ctx.spec.id.replace(/^api:/, "");
    const outcome = await call(ctx, provider, opts);
    const base = { runId: ctx.runId, agent: ctx.spec.id };
    if (outcome.text !== "") ctx.emit({ kind: "message", ...base, body: outcome.text });
    if (outcome.error !== null) ctx.emit({ kind: "error", ...base, body: outcome.error });
    return outcome;
  };
}

export const runApi: Adapter = createApiAdapter({});
