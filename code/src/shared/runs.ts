import { z } from "zod";

const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "killed",
] as const;
type RunState = (typeof RUN_STATES)[number];

export interface StartRunBody {
  agentId: string;
  repo: string;
  prompt: string;
  model?: string | undefined;
}

// Absolute only: the worktree is cut from this path, a relative one would resolve against the server cwd.
export const startRunBody: z.ZodType<StartRunBody> = z.object({
  agentId: z.string().min(1).max(64),
  repo: z.string().min(1).max(4096).regex(/^\//, "repo must be an absolute path"),
  prompt: z.string().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
});

export interface DecisionBody {
  decision: "approve" | "deny";
}
export const decisionBody: z.ZodType<DecisionBody> = z.object({
  decision: z.enum(["approve", "deny"]),
});

export interface HaltBody {
  halted: boolean;
}
export const haltBody: z.ZodType<HaltBody> = z.object({ halted: z.boolean() });

export interface RunView {
  id: string;
  agentId: string;
  model: string | null;
  repo: string;
  branch: string | null;
  prompt: string;
  state: RunState;
  reason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  inputTokens: number;
  outputTokens: number;
}
export const runViewSchema: z.ZodType<RunView> = z.object({
  id: z.string(),
  agentId: z.string(),
  model: z.string().nullable(),
  repo: z.string(),
  branch: z.string().nullable(),
  prompt: z.string(),
  state: z.enum(RUN_STATES),
  reason: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export interface EventView {
  rowid: number;
  ts: number;
  kind: string;
  toolName: string | null;
  command: string | null;
  exitCode: number | null;
  guardLayer: string | null;
  guardVerdict: string | null;
  guardRule: string | null;
  body: string | null;
}
const eventViewSchema: z.ZodType<EventView> = z.object({
  rowid: z.number(),
  ts: z.number(),
  kind: z.string(),
  toolName: z.string().nullable(),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  guardLayer: z.string().nullable(),
  guardVerdict: z.string().nullable(),
  guardRule: z.string().nullable(),
  body: z.string().nullable(),
});

export interface RunDetail {
  run: RunView;
  events: EventView[];
}
export const runDetailSchema: z.ZodType<RunDetail> = z.object({
  run: runViewSchema,
  events: z.array(eventViewSchema),
});

export interface ApprovalView {
  id: string;
  runId: string;
  command: string;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}
export const approvalViewSchema: z.ZodType<ApprovalView> = z.object({
  id: z.string(),
  runId: z.string(),
  command: z.string(),
  reason: z.string().nullable(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  decidedBy: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  decidedAt: z.number().nullable(),
});

export const wsTopicSchema: z.ZodType<string> = z
  .string()
  .regex(/^(runs|approvals|run:[0-9a-f-]{36})$/);

// Bodies stay out of the socket: a message is only a nudge to refetch, so a huge tool output never rides it.
export type WsMessage =
  | { type: "event"; runId: string; event: { kind: string; ts: number | null } }
  | { type: "run"; run: RunView }
  | { type: "approval"; approval: ApprovalView };

export const wsMessageSchema: z.ZodType<WsMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    runId: z.string(),
    event: z.object({ kind: z.string(), ts: z.number().nullable() }),
  }),
  z.object({ type: z.literal("run"), run: runViewSchema }),
  z.object({ type: z.literal("approval"), approval: approvalViewSchema }),
]);

export interface AgentRow {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
  error: string | null;
  canLogin: boolean;
  enabled: boolean;
  models: Array<{ id: string; name: string }>;
}
export const agentRowSchema: z.ZodType<AgentRow> = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  error: z.string().nullable(),
  canLogin: z.boolean(),
  enabled: z.boolean(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});

export interface KeyStatus {
  provider: string;
  source: "env" | "keychain" | null;
}
export const keyStatusSchema: z.ZodType<KeyStatus> = z.object({
  provider: z.string(),
  source: z.enum(["env", "keychain"]).nullable(),
});

export interface OllayaStatus {
  up: boolean;
  version: string | null;
}
export const ollayaStatusSchema: z.ZodType<OllayaStatus> = z.object({
  up: z.boolean(),
  version: z.string().nullable(),
});

export interface SearchHitView {
  rowid: number;
  runId: string | null;
  kind: string;
  ts: number;
  snippet: string;
}
export const searchHitSchema: z.ZodType<SearchHitView> = z.object({
  rowid: z.number(),
  runId: z.string().nullable(),
  kind: z.string(),
  ts: z.number(),
  snippet: z.string(),
});
