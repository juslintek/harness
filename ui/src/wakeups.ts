import { z } from "zod";

// The fields features read from GET /api/orgs/:org/wakeups (WakeupView in shared/heartbeat).
export const wakeupSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  reason: z.string(),
  taskId: z.string().nullable(),
  taskNumber: z.number().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  causedBy: z.string().nullable(),
  status: z.enum(["pending", "started", "done", "failed", "skipped"]),
  runId: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type Wakeup = z.infer<typeof wakeupSchema>;

export const wakeupList = z.array(wakeupSchema);

// Why a wakeup happened, in plain words. `person` names whoever caused a "run now"; `long` is the
// run page wording.
export function wakeReason(w: Wakeup, person?: string, long = false): string {
  switch (w.reason) {
    case "assignment":
      return w.taskNumber === null
        ? "Assigned a task"
        : `Assigned ${long ? "task " : ""}#${w.taskNumber}`;
    case "mention":
      return w.channelName ? `Mentioned in #${w.channelName}` : "Mentioned in chat";
    case "run_now":
      return person ? `Run now by ${person}` : "Run now";
    default: {
      const plain = w.reason.replaceAll("_", " ");
      return plain.charAt(0).toUpperCase() + plain.slice(1);
    }
  }
}
