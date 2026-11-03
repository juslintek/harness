export type EstimateKind = "planner" | "reviewer";
export type EstimateSource = "agent" | "human" | "laya_prior";

export interface TimeRow {
  runId: string;
  memberId: string;
  taskId: string | null;
  wallMs: number;
  waitingMs: number;
  activeMs: number;
}

export interface EstimateView {
  id: string;
  taskId: string;
  kind: EstimateKind;
  minutes: number;
  source: EstimateSource;
  byMember: string | null;
  rationale: string | null;
  createdAt: number;
}

export interface MemberReport {
  memberId: string;
  handle: string;
  runs: number;
  completed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  unpricedEvents: number;
  wallMs: number;
  activeMs: number;
  waitingMs: number;
  plannerMinutes: number;
  reviewerMinutes: number;
  tasksDone: number;
  tools: { name: string; count: number }[];
  stack: string[];
}
