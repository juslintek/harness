import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSpec } from "../agents/api";
import type { NewEvent } from "../logs/api";
import type { RunOutcome } from "./adapter";
import { runAgy } from "./agy";

const dir = mkdtempSync(join(tmpdir(), "agy-test-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const FAKE = join(dir, "fake-agy.js");
writeFileSync(
  FAKE,
  `const fs = require("fs");
fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
fs.writeSync(1, fs.readFileSync(process.env.FAKE_LINES, "utf8"));
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`,
);

const usage = (input: number, cached = 0): Record<string, number> => ({
  input_tokens: input,
  output_tokens: 162,
  thinking_tokens: 161,
  cache_read_tokens: cached,
  total_tokens: input + 162,
});
const line = (v: unknown): string => JSON.stringify(v);
const step = (s: Record<string, unknown>): string => line({ event: "step_update", step_update: s });
const result = (r: Record<string, unknown>): string => line({ event: "result", result: r });
const init = line({
  event: "init",
  conversation_id: "conv-1",
  init: { permission_mode: "request-review" },
});

interface Opts {
  exit?: number;
  hang?: boolean;
  model?: string | null;
  idle?: number;
  abortAfter?: number;
  onSpawn?: (pid: number) => void;
}

let seq = 0;
async function run(
  lines: string[],
  opts: Opts = {},
): Promise<{ outcome: RunOutcome; events: NewEvent[]; argv: string[] }> {
  const id = ++seq;
  const linesFile = join(dir, `lines-${id}`);
  const argvFile = join(dir, `argv-${id}`);
  writeFileSync(linesFile, `${lines.join("\n")}\n`);
  const spec = getSpec("agy");
  if (!spec) throw new Error("spec missing");
  const events: NewEvent[] = [];
  const abort = new AbortController();
  if (opts.abortAfter !== undefined) setTimeout(() => abort.abort(), opts.abortAfter);
  const outcome = await runAgy({
    runId: `run-${id}`,
    cwd: dir,
    prompt: "say ok",
    model: opts.model ?? null,
    spec,
    argv: [process.execPath, FAKE],
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_LINES: linesFile,
      FAKE_ARGV: argvFile,
      FAKE_EXIT: String(opts.exit ?? 0),
      ...(opts.hang ? { FAKE_HANG: "1" } : {}),
    },
    mcp: null,
    claudeSettings: {},
    emit: (e) => events.push(e),
    decide: () => Promise.resolve("deny"),
    onQuota: () => {},
    signal: abort.signal,
    ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    idleTimeoutMs: opts.idle ?? 10_000,
  });
  const argv = existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, "utf8")) : [];
  return { outcome, events, argv };
}

const agentStep = (state: string, delta: string, extra = {}): string =>
  step({ step_index: 2, state, step_type: "agent_response", text_delta: delta, ...extra });

// The real run said ERROR (network retry) although the answer arrived.
const spike = [
  init,
  step({ step_index: 0, state: "DONE", step_type: "user_input" }),
  step({ step_index: 1, state: "DONE", step_type: "error_message" }),
  agentStep("ACTIVE", "o"),
  agentStep("ACTIVE", "k"),
  agentStep("DONE", "\n", { usage: usage(31623) }),
  result({
    conversation_id: "conv-1",
    status: "ERROR",
    response: "ok\n",
    error: "attempt 1 timed out",
    usage: usage(31623),
  }),
];

test("a response with exit 0 is end_turn whatever result.status says", async () => {
  const { outcome, events, argv } = await run(spike, { model: "gemini-4-argon-low" });
  expect(outcome).toMatchObject({
    stopReason: "end_turn",
    text: "ok\n",
    error: null,
    sessionId: "conv-1",
  });
  expect(outcome.usage).toEqual([
    {
      model: "gemini-4-argon-low",
      inputTokens: 31623,
      outputTokens: 162,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 161,
      reportedCostUsd: null,
      source: "agy",
    },
  ]);
  expect(argv).toEqual([
    "-p",
    "say ok",
    "--output-format",
    "stream-json",
    "--settings",
    '{"permissions":{"allow":[]}}',
    "--model",
    "gemini-4-argon-low",
  ]);
  const deltas = events.filter((e) => e.kind === "message" && e.body === "ok\n");
  expect(deltas).toHaveLength(1);
  expect(events.some((e) => e.kind === "run")).toBe(true);
  expect(events.some((e) => e.kind === "error")).toBe(false);
});

test("no model flag when the run has no model", async () => {
  const { argv } = await run(spike);
  expect(argv).not.toContain("--model");
});

test("cached tokens are taken out of input, floored at 0", async () => {
  const { outcome } = await run([result({ response: "x", usage: usage(100, 30) })]);
  expect(outcome.usage[0]).toMatchObject({ inputTokens: 70, cacheReadTokens: 30 });
  const over = await run([result({ response: "x", usage: usage(10, 30) })]);
  expect(over.outcome.usage[0]?.inputTokens).toBe(0);
});

test("empty response with exit 1 is an error carrying result.error", async () => {
  const { outcome, events } = await run([init, result({ response: "", error: "quota exceeded" })], {
    exit: 1,
  });
  expect(outcome).toMatchObject({ stopReason: "error", error: "quota exceeded" });
  expect(events.at(-1)).toMatchObject({ kind: "error", body: "quota exceeded" });
});

test("SUCCESS with an empty response and denied actions is an error naming them", async () => {
  const denied = [{ action: "read_file", display_name: "ReadFile" }];
  const { outcome } = await run([
    result({ status: "SUCCESS", response: "", denied_actions: denied }),
  ]);
  expect(outcome.stopReason).toBe("error");
  expect(outcome.error).toContain("read_file");
});

test("a response with a non-zero exit is an error and keeps the text", async () => {
  const { outcome } = await run([result({ response: "partial" })], { exit: 2 });
  expect(outcome).toMatchObject({ stopReason: "error", text: "partial" });
  expect(outcome.error).toContain("exited with 2");
});

test("tool steps become tool_call and unknown lines are kept as messages, never fatal", async () => {
  const { outcome, events } = await run([
    step({ step_index: 3, state: "ERROR", step_type: "tool", tool_name: "read_file" }),
    line({ event: "brand_new", x: 1 }),
    "not json at all",
    result({ response: "fine" }),
  ]);
  expect(outcome.stopReason).toBe("end_turn");
  expect(events.find((e) => e.kind === "tool_call")?.toolName).toBe("read_file");
  const bodies = events.filter((e) => e.kind === "message").map((e) => e.body);
  expect(bodies).toContain('{"event":"brand_new","x":1}');
  expect(bodies).toContain("not json at all");
});

test("silence past the idle limit is a timeout", async () => {
  const { outcome } = await run([init], { hang: true, idle: 400 });
  expect(outcome.stopReason).toBe("timeout");
});

test("abort ends the run as cancelled", async () => {
  const { outcome } = await run([init], { hang: true, abortAfter: 300 });
  expect(outcome).toMatchObject({ stopReason: "cancelled", error: null });
});

test("an onSpawn that throws ends the run as error and the process is gone", async () => {
  let spawned = 0;
  const { outcome } = await run([init], {
    hang: true,
    onSpawn: (pid) => {
      spawned = pid;
      throw new Error("pid write failed");
    },
  });
  expect(outcome.stopReason).toBe("error");
  expect(outcome.error).toContain("pid write failed");
  expect(() => process.kill(spawned, 0)).toThrow();
});

test("a run that got some actions denied still succeeds but tells the user which", async () => {
  const { outcome, events } = await run([
    result({
      response: "done",
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
    }),
  ]);
  expect(outcome).toMatchObject({ stopReason: "end_turn", error: null });
  expect(events.at(-1)).toMatchObject({
    kind: "message",
    body: expect.stringContaining("command"),
  });
});

test("argv never opens a permission mode or skips permissions", async () => {
  const { argv } = await run([result({ response: "ok" })]);
  expect(argv).not.toContain("--mode");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv[argv.indexOf("--settings") + 1]).toBe('{"permissions":{"allow":[]}}');
});
