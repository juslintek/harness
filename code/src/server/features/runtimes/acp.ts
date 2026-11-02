import type { Rec } from "./acp-rpc";
import { abortion, type Clock, Connection, idleClock, rec, terminate, within } from "./acp-rpc";
import { pickOption, UpdateSink, usageRecords } from "./acp-updates";
import type { Adapter, PermissionAsk, RunContext, RunOutcome } from "./adapter";

const CANCEL_GRACE_MS = 2000;
const CLOSE_GRACE_MS = 5000;
const DECIDE_TIMEOUT_MS = 15 * 60_000;
const STOP_REASONS = ["end_turn", "cancelled", "max_tokens", "refusal"] as const;

function newSessionParams(ctx: RunContext): Rec {
  const params: Rec = {
    cwd: ctx.cwd,
    mcpServers: ctx.mcp
      ? [
          {
            type: "http",
            name: "harness",
            url: ctx.mcp.url,
            headers: [{ name: "Authorization", value: `Bearer ${ctx.mcp.token}` }],
          },
        ]
      : [],
  };
  if (ctx.spec.claudeMeta) {
    params._meta = {
      claudeCode: {
        options: { settingSources: [], settings: ctx.claudeSettings, env: ctx.env },
      },
    };
  }
  return params;
}

interface Shared {
  sessionId: string | null;
  // Number of permission decisions waiting on the harness; the idle clock stops while it is > 0.
  deciding: number;
  fault: string | null;
  raise(err: unknown): void;
}

// An exception from emit, a handler or the permission path ends the run as `error` right away
// instead of waiting for the idle clock.
function newShared(): { shared: Shared; faulted: Promise<"fault"> } {
  let trip: (v: "fault") => void = () => {};
  const faulted = new Promise<"fault">((resolve) => {
    trip = resolve;
  });
  const shared: Shared = {
    sessionId: null,
    deciding: 0,
    fault: null,
    raise(err) {
      if (this.fault !== null) return;
      console.error("acp run fault", err);
      this.fault = err instanceof Error ? err.message : String(err);
      trip("fault");
    },
  };
  return { shared, faulted };
}

async function converse(
  conn: Connection,
  ctx: RunContext,
  sink: UpdateSink,
  shared: Shared,
): Promise<RunOutcome> {
  await conn.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "harness", version: "0" },
  });
  if (ctx.spec.modeOption === null) {
    ctx.emit({
      kind: "guard",
      runId: ctx.runId,
      agent: ctx.spec.id,
      guardLayer: "L0",
      guardVerdict: "ask",
      guardRule: "no_permission_mode",
      body: "agent has no permission mode to set; only L0 and native rules protect this run",
    });
  }
  const created = rec(await conn.request("session/new", newSessionParams(ctx)));
  const sessionId = created.sessionId;
  if (typeof sessionId !== "string") throw new Error("session/new returned no sessionId");
  shared.sessionId = sessionId;
  const options: Array<{ configId: string; value: string }> = [];
  if (ctx.spec.modeOption) options.push(ctx.spec.modeOption);
  if (ctx.model) options.push({ configId: "model", value: ctx.model });
  for (const option of options) {
    await conn.request("session/set_config_option", { sessionId, ...option });
  }
  const response = rec(
    await conn.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: ctx.prompt }],
    }),
  );
  sink.flush();
  const stop = STOP_REASONS.find((s) => s === response.stopReason);
  return {
    stopReason: stop ?? "error",
    text: sink.text,
    usage: usageRecords(response, ctx.model, sink.costUsd),
    error: stop ? null : `unexpected stop reason ${String(response.stopReason)}`,
    sessionId,
  };
}

// Anything but a clear allow is a deny; a decide that never answers is cut off here so the run
// cannot sit on a pending permission forever.
async function verdictFor(ctx: RunContext, ask: PermissionAsk): Promise<"allow" | "deny"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ctx.decideTimeoutMs ?? DECIDE_TIMEOUT_MS);
  });
  try {
    const verdict = await Promise.race([ctx.decide(ask), expired]);
    if (verdict !== "timeout") return verdict;
    ctx.emit({
      kind: "guard",
      runId: ctx.runId,
      agent: ctx.spec.id,
      guardVerdict: "deny",
      guardLayer: "L3",
      guardRule: "decide_timeout",
      body: "decide timeout",
    });
  } catch (err) {
    ctx.emit({
      kind: "error",
      runId: ctx.runId,
      agent: ctx.spec.id,
      body: `decide failed, denying: ${String(err)}`,
    });
  } finally {
    clearTimeout(timer);
  }
  return "deny";
}

async function answerPermission(
  conn: Connection,
  ctx: RunContext,
  sink: UpdateSink,
  msg: Rec,
  shared: Shared,
): Promise<void> {
  const params = rec(msg.params);
  const ask = sink.describe(rec(params.toolCall));
  sink.flush();
  shared.deciding++;
  const verdict = await verdictFor(ctx, ask).finally(() => {
    shared.deciding--;
  });
  let pick = pickOption(params.options, verdict);
  if (pick.optionId === null && pick.allowAlwaysOnly) {
    ctx.emit({
      kind: "error",
      runId: ctx.runId,
      body: "allow_always only: no allow_once option offered, answering reject",
    });
    pick = pickOption(params.options, "deny");
  }
  conn.respond(msg.id, {
    outcome:
      pick.optionId === null
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: pick.optionId },
  });
  ctx.emit({
    kind: "permission",
    runId: ctx.runId,
    agent: ctx.spec.id,
    ...(ask.command === undefined ? {} : { command: ask.command }),
    ...(ask.toolName === undefined ? {} : { toolName: ask.toolName }),
    body: `${verdict} ${pick.optionId ?? "cancelled"}`,
  });
}

async function settle(
  conn: Connection,
  ctx: RunContext,
  sink: UpdateSink,
  shared: Shared,
  clock: Clock,
  faulted: Promise<"fault">,
): Promise<RunOutcome> {
  const stopped = (stopReason: RunOutcome["stopReason"], error: string | null): RunOutcome => {
    sink.flush();
    return { stopReason, text: sink.text, usage: [], error, sessionId: shared.sessionId };
  };
  const main = converse(conn, ctx, sink, shared);
  // Settled by the race below or by the process dying; never an unhandled rejection.
  main.catch(() => undefined);
  try {
    const first = await Promise.race([main, clock.expired, abortion(ctx.signal), faulted]);
    if (first === "fault") return stopped("error", `adapter fault: ${shared.fault}`);
    if (first === "timeout") return stopped("timeout", `no update for ${ctx.idleTimeoutMs} ms`);
    if (first === "aborted") {
      conn.notify("session/cancel", { sessionId: shared.sessionId });
      await Promise.race([main.catch(() => null), Bun.sleep(CANCEL_GRACE_MS)]);
      return stopped("cancelled", null);
    }
    return first;
  } catch (err) {
    return stopped("error", err instanceof Error ? err.message : String(err));
  }
}

export const runAcp: Adapter = async (ctx) => {
  const proc = Bun.spawn(ctx.argv, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  ctx.onSpawn?.(proc.pid);
  const { shared, faulted } = newShared();
  const safe: RunContext = {
    ...ctx,
    emit: (e) => {
      try {
        ctx.emit(e);
      } catch (err) {
        shared.raise(err);
      }
    },
  };
  const sink = new UpdateSink(safe);
  const clock = idleClock(ctx.idleTimeoutMs, () => shared.deciding > 0);
  const conn: Connection = new Connection(proc, (msg) => {
    try {
      clock.touch();
      if (msg.method === "session/update") sink.handle(rec(rec(msg.params).update));
      else if (msg.method === "session/request_permission") {
        if (msg.id !== undefined) {
          answerPermission(conn, safe, sink, msg, shared).catch((err) => shared.raise(err));
        }
      } else if (msg.id !== undefined) conn.refuse(msg.id, String(msg.method));
    } catch (err) {
      shared.raise(err);
    }
  });
  try {
    const outcome = await settle(conn, safe, sink, shared, clock, faulted);
    if (outcome.error !== null) {
      safe.emit({ kind: "error", runId: ctx.runId, agent: ctx.spec.id, body: outcome.error });
    }
    return outcome;
  } finally {
    clock.stop();
    await terminate(proc);
    await within(conn.closed, CLOSE_GRACE_MS);
  }
};
