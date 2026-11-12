import type { HireView } from "@shared/hiring";

// The server rejects scores outside "scoring" and decisions outside "deciding", so the forms only show then.
export const hirePhase = (status: HireView["status"]): { scoring: boolean; deciding: boolean } => ({
  scoring: status === "scoring",
  deciding: status === "deciding",
});

export const HIRE_TONE: Record<
  HireView["status"],
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  interviewing: "info",
  followups: "info",
  answering: "info",
  scoring: "info",
  deciding: "warning",
  hired: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export const CANDIDATE_TONE: Record<
  HireView["candidates"][number]["status"],
  "neutral" | "info" | "success" | "danger"
> = {
  pending: "neutral",
  interviewing: "info",
  answered: "neutral",
  failed: "danger",
  hired: "success",
  rejected: "danger",
};
