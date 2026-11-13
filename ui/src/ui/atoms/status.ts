import type { Tone } from "./status-badge";

export type StatusKind =
  | "approval"
  | "budget"
  | "candidate"
  | "guard"
  | "hire"
  | "run"
  | "task"
  | "wakeup";

const BY_KIND: Record<StatusKind, Record<string, { word: string; tone: Tone }>> = {
  approval: {
    pending: { word: "waiting for you", tone: "warning" },
    approved: { word: "approved", tone: "success" },
    denied: { word: "denied", tone: "danger" },
    expired: { word: "expired", tone: "neutral" },
  },
  budget: {
    ok: { word: "ok", tone: "success" },
    warn: { word: "near limit", tone: "warning" },
    paused: { word: "paused", tone: "danger" },
  },
  hire: {
    interviewing: { word: "interviewing", tone: "info" },
    followups: { word: "follow-ups", tone: "info" },
    answering: { word: "answering follow-ups", tone: "info" },
    scoring: { word: "scoring", tone: "info" },
    deciding: { word: "needs your decision", tone: "warning" },
    hired: { word: "hired", tone: "success" },
    rejected: { word: "rejected", tone: "danger" },
    cancelled: { word: "cancelled", tone: "neutral" },
  },
  wakeup: {
    pending: { word: "queued", tone: "neutral" },
    started: { word: "running", tone: "info" },
  },
  guard: {
    ask: { word: "guard asked", tone: "warning" },
    deny: { word: "guard denied", tone: "danger" },
    allow: { word: "guard allowed", tone: "success" },
  },
  run: {
    queued: { word: "queued", tone: "neutral" },
    starting: { word: "starting", tone: "info" },
    running: { word: "running", tone: "info" },
    completed: { word: "completed", tone: "success" },
    failed: { word: "failed", tone: "danger" },
    blocked: { word: "blocked", tone: "danger" },
    cancelled: { word: "cancelled", tone: "neutral" },
    killed: { word: "killed", tone: "danger" },
  },
  task: {
    backlog: { word: "backlog", tone: "neutral" },
    todo: { word: "todo", tone: "neutral" },
    in_progress: { word: "in progress", tone: "info" },
    in_review: { word: "in review", tone: "warning" },
    done: { word: "done", tone: "success" },
    blocked: { word: "blocked", tone: "danger" },
    cancelled: { word: "cancelled", tone: "neutral" },
  },
  candidate: {
    pending: { word: "pending", tone: "neutral" },
    interviewing: { word: "interviewing", tone: "info" },
    answered: { word: "answered", tone: "neutral" },
    failed: { word: "failed", tone: "danger" },
    hired: { word: "hired", tone: "success" },
    rejected: { word: "rejected", tone: "danger" },
  },
};

const PLAIN: Record<string, string> = { tool_call: "command" };

// One place for the plain word of a raw enum value (DESIGN.md "Status words"). Without a kind, a
// value gets its underscores turned into spaces; callers that already know the tone keep it.
export function statusWord(value: string, kind?: StatusKind): { word: string; tone: Tone } {
  const known = kind ? BY_KIND[kind][value] : undefined;
  if (known) return known;
  if (value === "waiting_approval") return { word: "waiting for you", tone: "warning" };
  return { word: PLAIN[value] ?? value.replaceAll("_", " "), tone: "neutral" };
}
