import type { Database } from "bun:sqlite";
import type { BudgetScopeKind, BudgetState, BudgetView } from "../../../shared/budgets";
import { estimateCostUsd } from "../router/api";
import { type BudgetRow, budgetsCovering, SCOPE_MEMBERS_SQL } from "./repo";

const WARN_RATIO = 0.8;

interface Scope {
  kind: BudgetScopeKind;
  id: string;
}

interface Group {
  runtime: string;
  model: string | null;
  events: number;
  input: number;
  output: number;
  cache_read: number;
  cost: number | null;
  reported: number;
}

// Reported cost is trusted as is; events without one (codex) are priced from the registry, and a
// model the registry does not know counts 0 but is surfaced as unpriced.
function spendOf(
  db: Database,
  scope: Scope,
  periodStart: number,
): { usd: number; unpriced: number } {
  const groups = db
    .query<Group, [number, string]>(
      `SELECT r.agent_id AS runtime, e.gen_ai_request_model AS model, count(*) AS events,
         COALESCE(sum(e.gen_ai_usage_input_tokens), 0) AS input,
         COALESCE(sum(e.gen_ai_usage_output_tokens), 0) AS output,
         COALESCE(sum(e.cache_read_tokens), 0) AS cache_read,
         sum(e.reported_cost_usd) AS cost,
         e.reported_cost_usd IS NOT NULL AS reported
       FROM events e JOIN runs r ON r.id = e.run_id
       WHERE e.kind = 'usage' AND e.ts >= ?
         AND r.member_id IN (${SCOPE_MEMBERS_SQL[scope.kind]})
       GROUP BY r.agent_id, e.gen_ai_request_model, reported`,
    )
    .all(periodStart, scope.id);
  let usd = 0;
  let unpriced = 0;
  for (const g of groups) {
    if (g.reported === 1) {
      usd += g.cost ?? 0;
      continue;
    }
    const estimate = estimateCostUsd(db, g.runtime, g.model, {
      input: g.input,
      output: g.output,
      cacheRead: g.cache_read,
    });
    if (estimate === null) unpriced += g.events;
    else usd += estimate;
  }
  return { usd, unpriced };
}

export function spendUsd(db: Database, scope: Scope, periodStart: number): number {
  return spendOf(db, scope, periodStart).usd;
}

export function periodStartOf(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function periodKey(now: number): string {
  return new Date(periodStartOf(now)).toISOString().slice(0, 7);
}

function stateOf(ratio: number): BudgetState {
  if (ratio >= 1) return "paused";
  return ratio >= WARN_RATIO ? "warn" : "ok";
}

export function viewOf(db: Database, b: BudgetRow, now: number): BudgetView {
  const { usd, unpriced } = spendOf(db, { kind: b.scopeKind, id: b.scopeId }, periodStartOf(now));
  const ratio = usd / b.monthlyUsd;
  return {
    id: b.id,
    scopeKind: b.scopeKind,
    scopeId: b.scopeId,
    monthlyUsd: b.monthlyUsd,
    spentUsd: usd,
    ratio,
    state: stateOf(ratio),
    unpriced,
  };
}

export function budgetGate(
  db: Database,
  memberId: string,
  now: number = Date.now(),
): { state: BudgetState; budgets: BudgetView[] } {
  const budgets = budgetsCovering(db, memberId).map((b) => viewOf(db, b, now));
  const has = (state: BudgetState): boolean => budgets.some((b) => b.state === state);
  if (has("paused")) return { state: "paused", budgets };
  return { state: has("warn") ? "warn" : "ok", budgets };
}
