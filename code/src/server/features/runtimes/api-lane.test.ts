import { afterAll, expect, test } from "bun:test";
import { startStub, stopStubs } from "../../test-support/stub-server";
import { getSpec } from "../agents/api";
import type { NewEvent } from "../logs/api";
import type { RunOutcome } from "./adapter";
import { createApiAdapter, runApi } from "./api-lane";

const KEY = "sk-test-key-123456";
const seen: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
let reply: () => Response = () => new Response("{}");

const server = await startStub(async (req) => {
  seen.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.json() });
  return reply();
});
const hung = await startStub(() => new Promise<Response>(() => {}));
afterAll(stopStubs);

interface Opts {
  model?: string | null;
  key?: string | null;
  idle?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  hung?: boolean;
}

async function run(
  provider: string,
  opts: Opts = {},
): Promise<{ outcome: RunOutcome; events: NewEvent[] }> {
  const base = getSpec("claude");
  if (!base) throw new Error("spec missing");
  const events: NewEvent[] = [];
  const target = `${(opts.hung ? hung : server).url}/v1`;
  const adapter = createApiAdapter({
    getKey: () => Promise.resolve(opts.key === undefined ? KEY : opts.key),
    baseUrls: { openai: target, anthropic: target, ollama: target },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const outcome = await adapter({
    runId: "r1",
    cwd: "/tmp",
    prompt: "hi",
    model: opts.model === undefined ? "m-1" : opts.model,
    spec: { ...base, id: `api:${provider}`, lane: "api" },
    argv: [],
    env: {},
    mcp: null,
    claudeSettings: {},
    emit: (e) => events.push(e),
    decide: () => Promise.resolve("deny"),
    onQuota: () => {},
    signal: opts.signal ?? new AbortController().signal,
    idleTimeoutMs: opts.idle ?? 5000,
  });
  return { outcome, events };
}

test("openai shape: text, cached tokens out of input, bearer key", async () => {
  seen.length = 0;
  reply = () =>
    Response.json({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
  const { outcome, events } = await run("openai");
  expect(outcome).toMatchObject({ stopReason: "end_turn", text: "hello", error: null });
  expect(outcome.usage).toEqual([
    {
      model: "m-1",
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      reportedCostUsd: null,
      source: "api",
    },
  ]);
  expect(seen[0]?.path).toBe("/v1/chat/completions");
  expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(seen[0]?.body).toEqual({ model: "m-1", messages: [{ role: "user", content: "hi" }] });
  expect(JSON.stringify(events)).not.toContain(KEY);
});

test("finish_reason length maps to max_tokens", async () => {
  reply = () =>
    Response.json({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] });
  expect((await run("openai")).outcome.stopReason).toBe("max_tokens");
});

test("anthropic shape: native headers, cache fields mapped", async () => {
  seen.length = 0;
  reply = () =>
    Response.json({
      content: [
        { type: "text", text: "he" },
        { type: "text", text: "llo" },
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 13,
      },
    });
  const { outcome } = await run("anthropic");
  expect(outcome).toMatchObject({ stopReason: "end_turn", text: "hello" });
  expect(outcome.usage[0]).toMatchObject({
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 11,
    cacheWriteTokens: 13,
    source: "api",
  });
  expect(seen[0]?.path).toBe("/v1/messages");
  expect(seen[0]?.headers.get("x-api-key")).toBe(KEY);
  expect(seen[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(seen[0]?.body).toMatchObject({
    model: "m-1",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(typeof seen[0]?.body.max_tokens).toBe("number");
});

test("ollama needs no key and sends no authorization", async () => {
  seen.length = 0;
  reply = () => Response.json({ choices: [{ message: { content: "yo" } }] });
  const { outcome } = await run("ollama", { key: null });
  expect(outcome.stopReason).toBe("end_turn");
  expect(seen[0]?.headers.get("authorization")).toBeNull();
});

test("401 is an error and neither outcome nor events carry the key", async () => {
  reply = () => new Response(`bad key ${KEY}`, { status: 401 });
  const { outcome, events } = await run("openai");
  expect(outcome).toMatchObject({ stopReason: "error", text: "" });
  expect(outcome.error).toContain("401");
  expect(JSON.stringify({ outcome, events })).not.toContain(KEY);
});

test("a network error message is scrubbed of the key", async () => {
  const failing = (() =>
    Promise.reject(new Error(`connect failed for ${KEY}`))) as unknown as typeof fetch;
  const { outcome, events } = await run("openai", { fetch: failing });
  expect(outcome.stopReason).toBe("error");
  expect(JSON.stringify({ outcome, events })).not.toContain(KEY);
});

test("missing model, missing key and unknown provider are errors before any request", async () => {
  seen.length = 0;
  expect((await run("openai", { model: null })).outcome.error).toContain("model");
  expect((await run("openai", { key: null })).outcome.error).toContain("no api key");
  expect((await run("nope")).outcome.error).toContain("unknown api provider");
  expect(seen).toHaveLength(0);
});

test("an empty completion is an error", async () => {
  reply = () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  expect((await run("openai")).outcome.stopReason).toBe("error");
});

test("a slow server times out and an abort cancels", async () => {
  expect((await run("openai", { hung: true, idle: 200 })).outcome.stopReason).toBe("timeout");
  const aborted = await run("openai", { hung: true, signal: AbortSignal.timeout(100) });
  expect(aborted.outcome.stopReason).toBe("cancelled");
});

test("the default adapter rejects an unknown provider without touching the key store", async () => {
  const base = getSpec("claude");
  if (!base) throw new Error("spec missing");
  const outcome = await runApi({
    runId: "r",
    cwd: "/tmp",
    prompt: "hi",
    model: "m",
    spec: { ...base, id: "api:nope", lane: "api" },
    argv: [],
    env: {},
    mcp: null,
    claudeSettings: {},
    emit: () => {},
    decide: () => Promise.resolve("deny"),
    onQuota: () => {},
    signal: new AbortController().signal,
    idleTimeoutMs: 1000,
  });
  expect(outcome.error).toContain("unknown api provider");
});
