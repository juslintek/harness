import type { HireView } from "@shared/hiring";
import type { Step } from "../../ui/molecules";

type Status = HireView["status"];

// The server rejects scores outside "scoring" and decisions outside "deciding", so the forms only show then.
export const hirePhase = (status: Status): { scoring: boolean; deciding: boolean } => ({
  scoring: status === "scoring",
  deciding: status === "deciding",
});

export const STEP_NAMES = ["Interview", "Follow-ups", "Scoring", "Decision", "Hired"] as const;

// Where a request stands in the five steps; followups and answering are one step. A closed request
// is past the step it ended on, and a cancelled one says nothing about how far it got.
const STEP_OF: Record<Status, number> = {
  interviewing: 0,
  followups: 1,
  answering: 1,
  scoring: 2,
  deciding: 3,
  rejected: 4,
  hired: 5,
  cancelled: -1,
};

export const isOpen = (status: Status): boolean => STEP_OF[status] >= 0 && STEP_OF[status] < 4;

export function stepsOf(status: Status): Step[] | null {
  const at = STEP_OF[status];
  if (at < 0) return null;
  return STEP_NAMES.map((label, i) => ({
    label,
    state: i < at ? "done" : i === at ? "current" : "todo",
  }));
}

export const whereIs = (status: Status): string =>
  isOpen(status) ? `${STEP_NAMES[STEP_OF[status]]}, step ${STEP_OF[status] + 1} of 5` : "Closed";

const WHO_ACTS: Record<Status, string> = {
  interviewing: "The candidate agents answer 3 questions about the role and send a self card.",
  followups: "Up to 2 agents of the team may ask each candidate one more question.",
  answering: "The candidates answer the follow-up questions.",
  scoring: "Reviewers and admins score each candidate 1 to 5 on fit, depth and honesty.",
  deciding:
    "You or the team manager pick one candidate or reject all. The policy Who decides hires sets who is asked.",
  hired: "",
  rejected: "",
  cancelled: "",
};

export const whoActs = (status: Status): string =>
  isOpen(status)
    ? `${WHO_ACTS[status]} A step that is not done after 20 minutes moves on by itself.`
    : "";

// Waiting for you first, then open requests, then closed ones; newest first inside each group.
export function sortHires(list: HireView[]): HireView[] {
  const group = (h: HireView): number => (h.status === "deciding" ? 0 : isOpen(h.status) ? 1 : 2);
  return [...list].sort((a, b) => group(a) - group(b) || b.createdAt - a.createdAt);
}
