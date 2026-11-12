import type { RunView } from "@shared/runs";
import type { Tone } from "../../ui/primitives";

export function fmtTime(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toLocaleString();
}

export function fmtDuration(start: number | null, end: number | null): string {
  if (start === null) return "-";
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export const RUN_TONE: Record<RunView["state"], Tone> = {
  queued: "neutral",
  starting: "info",
  running: "info",
  completed: "success",
  failed: "danger",
  blocked: "danger",
  cancelled: "neutral",
  killed: "danger",
};

export const VERDICT_TONE: Record<string, Tone> = {
  allow: "success",
  ask: "warning",
  deny: "danger",
};

export const APPROVAL_TONE = {
  pending: "warning",
  approved: "success",
  denied: "danger",
  expired: "neutral",
} as const satisfies Record<string, Tone>;
