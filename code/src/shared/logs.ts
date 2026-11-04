import { z } from "zod";

export const LOG_KINDS = [
  "run",
  "message",
  "tool_call",
  "permission",
  "guard",
  "usage",
  "approval",
  "process",
  "error",
] as const;

export interface OrgLogHit {
  rowid: number;
  id: string;
  runId: string | null;
  kind: string;
  ts: number;
  snippet: string;
  memberHandle: string;
  taskId: string | null;
  projectId: string | null;
  taskNumber: number | null;
}

const orgLogHitSchema: z.ZodType<OrgLogHit> = z.object({
  rowid: z.number(),
  id: z.string(),
  runId: z.string().nullable(),
  kind: z.string(),
  ts: z.number(),
  snippet: z.string(),
  memberHandle: z.string(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskNumber: z.number().nullable(),
});

export const orgLogHitsSchema: z.ZodType<OrgLogHit[]> = z.array(orgLogHitSchema);
