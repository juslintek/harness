import { z } from "zod";

const budgetScopeKinds = ["org", "team", "member"] as const;
export type BudgetScopeKind = (typeof budgetScopeKinds)[number];

export type BudgetState = "ok" | "warn" | "paused";

export interface BudgetView {
  id: string;
  scopeKind: BudgetScopeKind;
  scopeId: string;
  monthlyUsd: number;
  spentUsd: number;
  ratio: number;
  state: BudgetState;
  unpriced: number;
}

export interface BudgetBody {
  scopeKind: BudgetScopeKind;
  scopeId: string;
  monthlyUsd: number;
}

export const budgetBody: z.ZodType<BudgetBody> = z
  .object({
    scopeKind: z.enum(budgetScopeKinds),
    scopeId: z.string().min(1).max(100),
    monthlyUsd: z.number().positive().finite(),
  })
  .strict();
