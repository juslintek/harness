import { z } from "zod";
import { type ApprovalView, approvalViewSchema, type RunView, runViewSchema } from "./runs";

export const wsTopicSchema: z.ZodType<string> = z
  .string()
  .regex(/^(runs|approvals|(run|org):[0-9a-f-]{36})$/);

// Bodies stay out of the socket: a message is only a nudge to refetch, so a huge tool output never rides it.
export type WsMessage =
  | { type: "event"; runId: string; event: { kind: string; ts: number | null } }
  | { type: "run"; run: RunView }
  | { type: "approval"; approval: ApprovalView }
  | { type: "task"; projectId: string; taskId: string; kind: string }
  | { type: "chat"; channelId: string; messageId: string; threadRootId: string | null };

export const wsMessageSchema: z.ZodType<WsMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    runId: z.string(),
    event: z.object({ kind: z.string(), ts: z.number().nullable() }),
  }),
  z.object({ type: z.literal("run"), run: runViewSchema }),
  z.object({ type: z.literal("approval"), approval: approvalViewSchema }),
  z.object({
    type: z.literal("task"),
    projectId: z.string(),
    taskId: z.string(),
    kind: z.string(),
  }),
  z.object({
    type: z.literal("chat"),
    channelId: z.string(),
    messageId: z.string(),
    threadRootId: z.string().nullable(),
  }),
]);
