import { z } from "zod";

export type WakeReason =
  | "assignment"
  | "comment"
  | "mention"
  | "laya_mention"
  | "subtask"
  | "schedule"
  | "run_now"
  | "hire_review"
  | "hire_decision"
  | "onboarding"
  | "approval_resolved"
  | "policy_review"
  | "retro"
  | "lesson_review";
export type WakeStatus = "pending" | "started" | "done" | "failed" | "skipped";

export interface WakeupView {
  id: string;
  memberId: string;
  reason: WakeReason;
  taskId: string | null;
  taskNumber: number | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  detail: unknown;
  causedBy: string | null;
  status: WakeStatus;
  runId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export const wakeBody: z.ZodType<{ taskId?: string | undefined }> = z.object({
  taskId: z.string().min(1).optional(),
});

export const wakeupsQuery: z.ZodType<{ limit: number }> = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
