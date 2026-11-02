// Scripted ACP agent for tests. FAKE_AGENT_SCRIPT is a JSON list of steps; FAKE_AGENT_PIDFILE, when
// set, receives this process id so tests can prove it is gone. The `ask` step never runs its command.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type OptionSet = "claude" | "codex" | "always-only";
type Step =
  | { say: string }
  | { ask: { command: string; kind?: string; options?: OptionSet } }
  | { readFile: string }
  | { writeFile: string }
  | {
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        thoughtTokens?: number;
        costUsd?: number;
        modelUsage?: Array<{ model: string; token_count: Record<string, number> }>;
        rateLimit?: { fiveHour: number; sevenDay: number; resetsAt: number };
      };
    }
  | { usageUpdate: number }
  | { crash: true }
  | { hang: true };

const OPTIONS: Record<OptionSet, unknown[]> = {
  claude: [
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "allow-with-updates", name: "Always", kind: "allow_always" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ],
  codex: [
    { optionId: "allow_once", name: "Yes", kind: "allow_once" },
    { optionId: "accept_execpolicy_amendment", name: "Always", kind: "allow_always" },
    { optionId: "cancel", name: "No", kind: "reject_once" },
  ],
  "always-only": [
    { optionId: "allow_always", name: "Always", kind: "allow_always" },
    { optionId: "cancel", name: "No", kind: "reject_once" },
  ],
};

const script: Step[] = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? "[]");
const pidFile = process.env.FAKE_AGENT_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
const logFile = process.env.FAKE_AGENT_LOG;

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const sessionId = "fake-session";
const update = (u: Record<string, unknown>): void =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (text: string): void =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const waiting = new Map<number, (result: unknown) => void>();
let nextId = 1;
let cancel: () => void = () => {};
const cancelled = new Promise<void>((resolve) => {
  cancel = resolve;
});

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function fsStep(op: "read" | "write", path: string): void {
  try {
    if (op === "read") readFileSync(path);
    else appendFileSync(path, "x");
    say(`${op}File ok`);
  } catch (err) {
    say(`${op}File error ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
}

async function ask(a: { command: string; kind?: string; options?: OptionSet }): Promise<void> {
  const result = (await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: `fake-${nextId}`,
      kind: a.kind ?? "execute",
      title: a.command,
      status: "pending",
      rawInput: { command: a.command },
    },
    options: OPTIONS[a.options ?? "claude"],
  })) as { outcome: { outcome: string; optionId?: string } };
  say(`permission ${result.outcome.outcome} ${result.outcome.optionId ?? ""}`.trim());
}

function fsOrUpdate(step: Step): boolean {
  if ("say" in step) say(step.say);
  else if ("readFile" in step) fsStep("read", step.readFile);
  else if ("writeFile" in step) fsStep("write", step.writeFile);
  else if ("usageUpdate" in step) {
    update({ sessionUpdate: "usage_update", used: step.usageUpdate, size: 1000 });
  } else return false;
  return true;
}

async function prompt(): Promise<unknown> {
  let usage: Record<string, unknown> | null = null;
  for (const step of script) {
    if (fsOrUpdate(step)) continue;
    if ("ask" in step) await ask(step.ask);
    else if ("crash" in step) {
      process.stderr.write("fake agent crashing\n");
      process.exit(3);
    } else if ("hang" in step) {
      await cancelled;
      return { stopReason: "cancelled" };
    } else if ("usage" in step) {
      usage = reportUsage(step.usage);
    }
  }
  return { stopReason: "end_turn", ...usage };
}

function reportUsage(u: Extract<Step, { usage: unknown }>["usage"]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (u.rateLimit) {
    meta["_claude/rateLimit"] = {
      unifiedWindows: {
        five_hour: { utilization: u.rateLimit.fiveHour, resetsAt: u.rateLimit.resetsAt },
        seven_day: { utilization: u.rateLimit.sevenDay, resetsAt: u.rateLimit.resetsAt },
      },
    };
  }
  update({
    sessionUpdate: "usage_update",
    used: 10,
    size: 100,
    ...(u.costUsd === undefined ? {} : { cost: { amount: u.costUsd, currency: "USD" } }),
    _meta: meta,
  });
  return {
    usage: {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedReadTokens: u.cachedReadTokens ?? 0,
      cachedWriteTokens: u.cachedWriteTokens ?? 0,
      thoughtTokens: u.thoughtTokens ?? 0,
    },
    ...(u.modelUsage ? { _meta: { quota: { model_usage: u.modelUsage } } } : {}),
  };
}

type Incoming = { id?: number; method?: string; params?: unknown; result?: unknown };

async function handle(msg: Incoming): Promise<void> {
  const reply = (result: unknown): void => send({ jsonrpc: "2.0", id: msg.id, result });
  if (logFile && msg.method !== undefined) appendFileSync(logFile, `${JSON.stringify(msg)}\n`);
  if (msg.method === undefined) {
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result);
  } else if (msg.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  } else if (msg.method === "session/new") {
    reply({ sessionId });
  } else if (msg.method === "session/set_config_option") {
    if (process.env.FAKE_AGENT_FAIL_CONFIG) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "config refused" } });
    } else reply({ configOptions: [] });
  } else if (msg.method === "session/cancel") {
    cancel();
  } else if (msg.method === "session/prompt") {
    reply(await prompt());
  }
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() !== "") void handle(JSON.parse(line));
    at = buffer.indexOf("\n");
  }
}
