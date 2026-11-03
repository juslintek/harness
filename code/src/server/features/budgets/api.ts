import type { Database } from "bun:sqlite";
import type { BudgetView } from "../../../shared/budgets";
import { listBudgets, upsertBudget } from "./repo";
import { budgetGate, viewOf } from "./spend";
import { startBudgets } from "./watch";

export function budgetViews(db: Database, orgId: string, now: number = Date.now()): BudgetView[] {
  return listBudgets(db, orgId).map((b) => viewOf(db, b, now));
}

export { budgetGate, startBudgets, upsertBudget };
