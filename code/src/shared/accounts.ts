import { z } from "zod";

const ACCOUNT_KINDS = ["login", "api_key"] as const;
const ACCOUNT_STATES = [
  "unknown",
  "pending",
  "active",
  "logged_out",
  "probe_failed",
  "disabled",
  "removing",
  "removed",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type AccountState = (typeof ACCOUNT_STATES)[number];

const accountKind: z.ZodType<AccountKind> = z.enum(ACCOUNT_KINDS);
const accountState: z.ZodType<AccountState> = z.enum(ACCOUNT_STATES);

export interface AccountView {
  id: string;
  runtime: string;
  kind: AccountKind;
  label: string;
  home: string | null;
  state: AccountState;
  identityHint: string | null;
  maxConcurrent: number;
  priority: number;
  exhaustedUntil: number | null;
  lastProbeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const accountView: z.ZodType<AccountView> = z.object({
  id: z.string(),
  runtime: z.string(),
  kind: accountKind,
  label: z.string(),
  home: z.string().nullable(),
  state: accountState,
  identityHint: z.string().nullable(),
  maxConcurrent: z.number().int(),
  priority: z.number().int(),
  exhaustedUntil: z.number().int().nullable(),
  lastProbeAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export interface AccountUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number | null;
  estimatedCostUsd: number;
  unpricedEvents: number;
  events: number;
}

export interface AccountUsageDay extends AccountUsageTotals {
  day: string;
}

export interface AccountUsageWindow extends AccountUsageTotals {
  window: string;
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface AccountUsageReport {
  accountId: string;
  runtime: string;
  totals: AccountUsageTotals;
  byDay: AccountUsageDay[];
  windows: AccountUsageWindow[];
}

const accountUsageTotalsSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  reportedCostUsd: z.number().nullable(),
  estimatedCostUsd: z.number(),
  unpricedEvents: z.number().int(),
  events: z.number().int(),
});

export const accountUsageReportSchema: z.ZodType<AccountUsageReport> = z.object({
  accountId: z.string(),
  runtime: z.string(),
  totals: accountUsageTotalsSchema,
  byDay: z.array(accountUsageTotalsSchema.extend({ day: z.string() })),
  windows: z.array(
    accountUsageTotalsSchema.extend({
      window: z.string(),
      usedPercent: z.number().nullable(),
      resetsAt: z.number().nullable(),
    }),
  ),
});

export function accountEnvFor(runtime: string, home: string | null): Record<string, string> {
  if (home === null) return {};
  if (runtime === "claude") return { CLAUDE_CONFIG_DIR: home };
  if (runtime === "codex") return { CODEX_HOME: home };
  return {};
}
