import type { AgentSpec } from "../agents/api";
import type { NewEvent } from "../logs/api";
import type { UsageRecord } from "../usage/api";

export interface PermissionAsk {
  kind: "execute" | "read" | "edit" | "delete" | "fetch" | "other";
  command?: string;
  paths: string[];
  toolName?: string;
  title?: string;
}

interface QuotaReading {
  provider: "claude";
  window: "five_hour" | "seven_day";
  usedPercent: number;
  // Epoch ms, like the rest of the harness.
  resetsAt: number | null;
}

export interface RunContext {
  runId: string;
  cwd: string;
  prompt: string;
  model: string | null;
  spec: AgentSpec;
  argv: string[];
  env: Record<string, string>;
  mcp: { url: string; token: string } | null;
  claudeSettings: unknown;
  emit(e: NewEvent): void;
  decide(ask: PermissionAsk): Promise<"allow" | "deny">;
  onQuota(q: QuotaReading): void;
  // Context fill reported by the agent on every usage_update, before any turn-end usage exists.
  onProgress?(p: { contextTokens: number }): void;
  // The agent is spawned detached, so its pid is also its process group id.
  onSpawn?(pid: number): void;
  signal: AbortSignal;
  idleTimeoutMs: number;
  // Upper bound for one decide() call; must exceed the approval timeout T8 enforces itself.
  decideTimeoutMs?: number;
}

export interface RunOutcome {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error" | "timeout";
  text: string;
  usage: UsageRecord[];
  error: string | null;
  sessionId: string | null;
}

export type Adapter = (ctx: RunContext) => Promise<RunOutcome>;
