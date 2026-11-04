import { z } from "zod";
import { type BudgetView, budgetViewSchema } from "./budgets";

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
  costEstimated: boolean;
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

export interface DashboardTask {
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  plannerMinutes: number | null;
  reviewerMinutes: number | null;
  agentActiveMinutes: number;
}

export interface QuotaWindow {
  provider: string;
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
  source: string;
  ts: number;
}

export interface DashboardView {
  members: MemberReport[];
  budgets: BudgetView[];
  quota: QuotaWindow[];
  tasks: DashboardTask[];
}

const memberReportSchema: z.ZodType<MemberReport> = z.object({
  memberId: z.string(),
  handle: z.string(),
  runs: z.number(),
  completed: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  costUsd: z.number(),
  costEstimated: z.boolean(),
  unpricedEvents: z.number(),
  wallMs: z.number(),
  activeMs: z.number(),
  waitingMs: z.number(),
  plannerMinutes: z.number(),
  reviewerMinutes: z.number(),
  tasksDone: z.number(),
  tools: z.array(z.object({ name: z.string(), count: z.number() })),
  stack: z.array(z.string()),
});

const quotaWindowSchema: z.ZodType<QuotaWindow> = z.object({
  provider: z.string(),
  window: z.string(),
  usedPercent: z.number().nullable(),
  resetsAt: z.number().nullable(),
  source: z.string(),
  ts: z.number(),
});

const dashboardTaskSchema: z.ZodType<DashboardTask> = z.object({
  number: z.number(),
  title: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  plannerMinutes: z.number().nullable(),
  reviewerMinutes: z.number().nullable(),
  agentActiveMinutes: z.number(),
});

export const dashboardViewSchema: z.ZodType<DashboardView> = z.object({
  members: z.array(memberReportSchema),
  budgets: z.array(budgetViewSchema),
  quota: z.array(quotaWindowSchema),
  tasks: z.array(dashboardTaskSchema),
});
