import { z } from "zod";

export type WakeReason =
  | "assignment"
  | "comment"
  | "mention"
  | "laya_mention"
  | "schedule"
  | "run_now";
export type WakeStatus = "pending" | "started" | "done" | "failed" | "skipped";

export interface WakeupView {
  id: string;
  memberId: string;
  reason: WakeReason;
  taskId: string | null;
  channelId: string | null;
  messageId: string | null;
  detail: unknown;
  causedBy: string | null;
  status: WakeStatus;
  runId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export const wakeupsQuery: z.ZodType<{ limit: number }> = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
