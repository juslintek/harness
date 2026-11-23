import { z } from "zod";
import type { Tone } from "../../ui/atoms";

const STATUSES = [
  "queued",
  "awaiting_approval",
  "checking",
  "building",
  "verifying",
  "swapping",
  "done",
  "rolled_back",
  "failed",
  "denied",
] as const;

export type UpdateStatus = (typeof STATUSES)[number];

export interface UpdateRequestView {
  id: string;
  repo: string;
  branch: string;
  commitSha: string;
  status: UpdateStatus;
  reason: string | null;
  flaggedPaths: string[];
  createdAt: number;
  log: string;
}

export interface Review {
  id: string;
  status: UpdateStatus;
  commitSha: string;
  flagged: string[];
  stat: string;
}

export const updateRequestSchema: z.ZodType<UpdateRequestView> = z.object({
  id: z.string(),
  repo: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  status: z.enum(STATUSES),
  reason: z.string().nullable(),
  flaggedPaths: z.array(z.string()),
  createdAt: z.number(),
  log: z.string(),
});

export const reviewSchema: z.ZodType<Review> = z.object({
  id: z.string(),
  status: z.enum(STATUSES),
  commitSha: z.string(),
  flagged: z.array(z.string()),
  stat: z.string(),
});

const FINISHED: UpdateStatus[] = ["done", "rolled_back", "failed", "denied"];
export const isFinished = (status: UpdateStatus): boolean => FINISHED.includes(status);

export function updateTone(status: UpdateStatus): Tone {
  if (status === "done") return "success";
  if (status === "awaiting_approval") return "warning";
  if (status === "rolled_back" || status === "failed" || status === "denied") return "danger";
  return "info";
}

const KEY = "harness.update-requests";

export function rememberedIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberId(id: string): void {
  try {
    const next = [id, ...rememberedIds().filter((x) => x !== id)].slice(0, 20);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the request still runs, it just is not listed after a reload.
  }
}
