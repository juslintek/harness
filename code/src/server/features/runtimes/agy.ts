import { z } from "zod";
import type { UsageRecord } from "../usage/api";
import { abortion, idleClock, type Proc, terminate, within } from "./acp-rpc";
import type { Adapter, RunContext, RunOutcome } from "./adapter";

const CLOSE_GRACE_MS = 5000;
const STDERR_TAIL = 2000;

const usageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  thinking_tokens: z.number().default(0),
  cache_read_tokens: z.number().default(0),
});

const eventSchema = z.union([
  z.object({ event: z.literal("init"), conversation_id: z.string().optional() }),
  z.object({
    event: z.literal("step_update"),
    step_update: z.object({
      state: z.string().optional(),
      step_type: z.string().optional(),
      text_delta: z.string().optional(),
      tool_name: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal("result"),
    result: z.object({
      conversation_id: z.string().optional(),
      response: z.string().default(""),
      error: z.string().optional(),
      denied_actions: z.array(z.object({ action: z.string() })).default([]),
      usage: usageSchema.optional(),
    }),
  }),
]);
type AgyResult = Extract<z.infer<typeof eventSchema>, { event: "result" }>["result"];

interface Seen {
  sessionId: string | null;
  result: AgyResult | null;
  // Text deltas of the open agent_response step, emitted as one message when the step closes.
  pending: string;
}

function base(ctx: RunContext): { runId: string; agent: string } {
  return { runId: ctx.runId, agent: ctx.spec.id };
}

function flush(ctx: RunContext, seen: Seen): void {
  if (seen.pending.trim() !== "") ctx.emit({ kind: "message", ...base(ctx), body: seen.pending });
  seen.pending = "";
}

function parseEvent(line: string): z.infer<typeof eventSchema> | null {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function handleLine(ctx: RunContext, seen: Seen, line: string): void {
  const event = parseEvent(line);
  if (event === null) {
    flush(ctx, seen);
    ctx.emit({ kind: "message", ...base(ctx), body: line });
    return;
  }
  if (event.event === "init") {
    seen.sessionId = event.conversation_id ?? seen.sessionId;
    return;
  }
  if (event.event === "result") {
    flush(ctx, seen);
    seen.result = event.result;
    seen.sessionId = event.result.conversation_id ?? seen.sessionId;
    ctx.emit({ kind: "run", ...base(ctx), body: line });
    return;
  }
  const step = event.step_update;
  if (step.step_type === "agent_response") {
    seen.pending += step.text_delta ?? "";
    if (step.state !== "ACTIVE") flush(ctx, seen);
    return;
  }
  flush(ctx, seen);
  if (step.step_type === "tool") {
    ctx.emit({
      kind: "tool_call",
      ...base(ctx),
      ...(step.tool_name === undefined ? {} : { toolName: step.tool_name }),
      body: line,
    });
  } else ctx.emit({ kind: "message", ...base(ctx), body: line });
}

// agy reports total input with the cached part inside; the other lanes store non-cached input.
function usageOf(result: AgyResult | null, model: string | null): UsageRecord[] {
  const usage = result?.usage;
  if (!usage) return [];
  return [
    {
      model,
      inputTokens: Math.max(0, usage.input_tokens - usage.cache_read_tokens),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheWriteTokens: 0,
      reasoningTokens: usage.thinking_tokens,
      reportedCostUsd: null,
      source: "agy",
    },
  ];
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
}

type Ending = "eof" | "timeout" | "aborted";

// Restarts the idle clock on every chunk; lines are handled as they complete.
async function pump(proc: Proc, ctx: RunContext, onLine: (line: string) => void): Promise<Ending> {
  let buffer = "";
  const clock = idleClock(ctx.idleTimeoutMs);
  const reading = drain(proc.stdout, (text) => {
    clock.touch();
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") onLine(line.trim());
  }).then(() => "eof" as const);
  // Settled by the race below or by the process dying; never an unhandled rejection.
  reading.catch(() => undefined);
  try {
    const ending = await Promise.race([reading, clock.expired, abortion(ctx.signal)]);
    if (ending === "eof" && buffer.trim() !== "") onLine(buffer.trim());
    return ending;
  } finally {
    clock.stop();
  }
}

// `result.status` is not trusted: a denied or failed run can still say SUCCESS.
function failure(result: AgyResult | null, code: number, stderr: string): string {
  if (result?.error) return result.error;
  const denied = result?.denied_actions.map((d) => d.action) ?? [];
  if (denied.length > 0) return `agy denied actions in headless mode: ${denied.join(", ")}`;
  if (code !== 0) return `agy exited with ${code}: ${stderr.trim()}`;
  return "agy returned an empty response";
}

async function finish(
  proc: Proc,
  ctx: RunContext,
  seen: Seen,
  stderr: () => string,
  errors: Promise<void>,
): Promise<RunOutcome> {
  const outcome = (
    stop: RunOutcome["stopReason"],
    error: string | null,
    text = "",
  ): RunOutcome => ({
    stopReason: stop,
    text,
    usage: usageOf(seen.result, ctx.model),
    error,
    sessionId: seen.sessionId,
  });
  const ending = await pump(proc, ctx, (line) => handleLine(ctx, seen, line));
  flush(ctx, seen);
  if (ending === "aborted") return outcome("cancelled", null);
  if (ending === "timeout") return outcome("timeout", `no output for ${ctx.idleTimeoutMs} ms`);
  // A process that closed stdout but never exits is left to terminate() in the caller.
  const code = await Promise.race([proc.exited, Bun.sleep(CLOSE_GRACE_MS).then(() => -1)]);
  await within(errors, CLOSE_GRACE_MS);
  const text = seen.result?.response ?? "";
  if (text.trim() !== "" && code === 0) return outcome("end_turn", null, text);
  return outcome("error", failure(seen.result, code, stderr()), text);
}

// agy -p cannot ask anyone: a tool outside its no-permission set is auto-denied, unless the user's
// own settings.json allow list (or a mode flag) opens it. --settings replaces that list (checked
// live on 1.4.12), so harness runs get none. There is no --mode value for the default
// (request-review), so the flag is left out; auto, accept-edits and
// --dangerously-skip-permissions must never be added here.
const NO_ALLOW_SETTINGS = JSON.stringify({ permissions: { allow: [] } });

export const runAgy: Adapter = async (ctx) => {
  const argv = [
    ...ctx.argv,
    "-p",
    ctx.prompt,
    "--output-format",
    "stream-json",
    "--settings",
    NO_ALLOW_SETTINGS,
  ];
  if (ctx.model) argv.push("--model", ctx.model);
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const seen: Seen = { sessionId: null, result: null, pending: "" };
  let stderr = "";
  const errors = drain(proc.stderr, (t) => {
    stderr = (stderr + t).slice(-STDERR_TAIL);
  });
  errors.catch(() => undefined);
  try {
    // Inside the try so a throwing onSpawn still reaches terminate().
    ctx.onSpawn?.(proc.pid);
    // terminate() wants a piped stdin; agy -p reads none, so close it right away.
    void proc.stdin.end();
    const outcome = await finish(proc, ctx, seen, () => stderr, errors);
    if (outcome.error !== null) {
      ctx.emit({ kind: "error", ...base(ctx), body: outcome.error });
    } else if (seen.result && seen.result.denied_actions.length > 0) {
      // A partly denied run still ends as a success; the user needs to see what agy wanted to do.
      const names = seen.result.denied_actions.map((d) => d.action).join(", ");
      ctx.emit({
        kind: "message",
        ...base(ctx),
        body: `agy denied actions in headless mode: ${names}`,
      });
    }
    return outcome;
  } catch (err) {
    return {
      stopReason: "error",
      text: "",
      usage: usageOf(seen.result, ctx.model),
      error: err instanceof Error ? err.message : String(err),
      sessionId: seen.sessionId,
    };
  } finally {
    await terminate(proc);
  }
};
