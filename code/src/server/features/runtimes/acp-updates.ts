import type { UsageRecord } from "../usage/api";
import { type Rec, rec } from "./acp-rpc";
import type { PermissionAsk, RunContext } from "./adapter";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface ToolInfo {
  title: string | undefined;
  kind: string | undefined;
  command: string | undefined;
  paths: string[];
}

function commandOf(rawInput: unknown): string | undefined {
  const cmd = rec(rawInput).command;
  if (Array.isArray(cmd)) return cmd.join(" ");
  return str(cmd);
}

function pathsOf(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((l) => {
    const p = str(rec(l).path);
    return p === undefined ? [] : [p];
  });
}

const MESSAGE_QUIET_MS = 300;
const WINDOWS = ["five_hour", "seven_day"] as const;

// Coalesces message chunks per message, remembers tool calls by id and keeps the turn's cost.
export class UpdateSink {
  text = "";
  costUsd: number | null = null;
  private readonly ctx: RunContext;
  private buffer: { thought: boolean; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tools = new Map<string, ToolInfo>();

  constructor(ctx: RunContext) {
    this.ctx = ctx;
  }

  handle(update: Rec): void {
    const type = str(update.sessionUpdate);
    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      const text = str(rec(update.content).text) ?? "";
      if (type === "agent_message_chunk") this.text += text;
      this.append(type === "agent_thought_chunk", text);
    } else if (type === "tool_call" || type === "tool_call_update") {
      this.flush();
      this.tool(update);
    } else if (type === "usage_update") {
      this.usage(update);
    }
  }

  flush(): void {
    clearTimeout(this.timer);
    if (this.buffer === null || this.buffer.text === "") return;
    this.ctx.emit({
      kind: "message",
      runId: this.ctx.runId,
      agent: this.ctx.spec.id,
      source: "acp",
      ...(this.buffer.thought ? { operation: "thought" } : {}),
      body: this.buffer.text,
    });
    this.buffer = null;
  }

  // Codex sends the permission request for an MCP call without title or input; the earlier
  // tool_call carries them.
  describe(toolCall: Rec): PermissionAsk {
    const known = this.tools.get(str(toolCall.toolCallId) ?? "");
    const kind = str(toolCall.kind) ?? known?.kind;
    const command = commandOf(toolCall.rawInput) ?? known?.command;
    const paths = pathsOf(toolCall.locations);
    const toolName = str(toolCall.name) ?? known?.title;
    const title = str(toolCall.title) ?? known?.title;
    return {
      kind: askKind(kind),
      paths: paths.length > 0 ? paths : (known?.paths ?? []),
      ...(command === undefined ? {} : { command }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(title === undefined ? {} : { title }),
    };
  }

  private append(thought: boolean, text: string): void {
    if (this.buffer !== null && this.buffer.thought !== thought) this.flush();
    this.buffer ??= { thought, text: "" };
    this.buffer.text += text;
    // A message that stalls (agent waiting on a tool, hung turn) still reaches the log.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), MESSAGE_QUIET_MS);
  }

  private tool(update: Rec): void {
    const id = str(update.toolCallId) ?? "";
    const prev = this.tools.get(id);
    const info: ToolInfo = {
      title: str(update.title) ?? prev?.title,
      kind: str(update.kind) ?? prev?.kind,
      command: commandOf(update.rawInput) ?? prev?.command,
      paths: pathsOf(update.locations).length > 0 ? pathsOf(update.locations) : (prev?.paths ?? []),
    };
    this.tools.set(id, info);
    this.ctx.emit({
      kind: "tool_call",
      runId: this.ctx.runId,
      agent: this.ctx.spec.id,
      source: "acp",
      toolName: info.title ?? info.kind ?? "tool",
      ...(info.command === undefined ? {} : { command: info.command }),
      body: str(update.status) ?? "",
    });
  }

  private usage(update: Rec): void {
    const amount = rec(update.cost).amount;
    if (typeof amount === "number") this.costUsd = amount;
    if (typeof update.used === "number") this.ctx.onProgress?.({ contextTokens: update.used });
    const windows = rec(rec(rec(update._meta)["_claude/rateLimit"]).unifiedWindows);
    for (const window of WINDOWS) {
      const w = rec(windows[window]);
      if (typeof w.utilization !== "number") continue;
      // Claude reports 0..1 and epoch seconds; the harness stores percent and epoch ms.
      this.ctx.onQuota({
        provider: "claude",
        window,
        usedPercent: w.utilization * 100,
        resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
      });
    }
  }
}

function askKind(kind: string | undefined): PermissionAsk["kind"] {
  switch (kind) {
    case "execute":
    case "read":
    case "edit":
    case "delete":
    case "fetch":
      return kind;
    case "search":
      return "read";
    case "move":
      return "edit";
    default:
      return "other";
  }
}

// Chosen by kind, never by id: Claude and Codex name their reject options differently, and
// allow_always writes a standing rule that the harness never grants.
export function pickOption(
  options: unknown,
  verdict: "allow" | "deny",
): { optionId: string | null; allowAlwaysOnly: boolean } {
  const list = Array.isArray(options) ? options.map(rec) : [];
  const wanted = verdict === "allow" ? "allow_once" : "reject_once";
  const hit = list.find((o) => o.kind === wanted);
  if (hit && typeof hit.optionId === "string")
    return { optionId: hit.optionId, allowAlwaysOnly: false };
  const allowAlwaysOnly = verdict === "allow" && list.some((o) => o.kind === "allow_always");
  return { optionId: null, allowAlwaysOnly };
}

// Both agents report inputTokens without the cached part (codex-acp measured live: 20037 input +
// 123264 cached + 675 output = 143976 total), so it is stored as reported.
function record(model: string | null, t: Rec): UsageRecord {
  return {
    model,
    inputTokens: num(t.inputTokens),
    outputTokens: num(t.outputTokens),
    cacheReadTokens: num(t.cachedInputTokens ?? t.cachedReadTokens),
    cacheWriteTokens: num(t.cachedWriteTokens ?? t.cacheWriteInputTokens),
    reasoningTokens: num(t.reasoningOutputTokens ?? t.thoughtTokens),
    reportedCostUsd: null,
    source: "acp",
  };
}

// One record per model when the agent splits them (that figure already includes helper models and
// subagents); otherwise the response total. The turn's cost is a single number, so it goes on the
// first record only and a sum over records never double-counts it.
export function usageRecords(
  response: Rec,
  model: string | null,
  costUsd: number | null,
): UsageRecord[] {
  const perModel = rec(rec(response._meta).quota).model_usage;
  const rows = Array.isArray(perModel)
    ? perModel.flatMap((m) => {
        const row = rec(m);
        const tokens = row.token_count;
        return typeof tokens === "object" && tokens !== null
          ? [record(str(row.model) ?? model, rec(tokens))]
          : [];
      })
    : [];
  if (rows.length === 0 && response.usage != null) {
    rows.push(record(model, rec(response.usage)));
  }
  const [first] = rows;
  if (first && costUsd !== null) first.reportedCostUsd = costUsd;
  return rows;
}
