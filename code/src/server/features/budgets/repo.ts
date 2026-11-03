import type { Database } from "bun:sqlite";
import type { BudgetBody, BudgetScopeKind } from "../../../shared/budgets";

export interface BudgetRow {
  id: string;
  orgId: string;
  scopeKind: BudgetScopeKind;
  scopeId: string;
  monthlyUsd: number;
}

export type BudgetLevel = "warn" | "pause";

interface Raw {
  id: string;
  org_id: string;
  scope_kind: BudgetScopeKind;
  scope_id: string;
  monthly_usd: number;
}

const row = (r: Raw): BudgetRow => ({
  id: r.id,
  orgId: r.org_id,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  monthlyUsd: r.monthly_usd,
});

export function listBudgets(db: Database, orgId: string): BudgetRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM budgets WHERE org_id = ? ORDER BY scope_kind, scope_id")
    .all(orgId)
    .map(row);
}

// Raising or lowering a limit keeps the row id, so alerts already sent this period stay recorded.
export function upsertBudget(
  db: Database,
  orgId: string,
  body: BudgetBody,
  createdBy: string,
): BudgetRow {
  const found = db
    .query<Raw, [string, string]>("SELECT * FROM budgets WHERE scope_kind = ? AND scope_id = ?")
    .get(body.scopeKind, body.scopeId);
  const id = found?.id ?? Bun.randomUUIDv7();
  db.query(
    `INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope_kind, scope_id) DO UPDATE SET monthly_usd = excluded.monthly_usd, updated_at = excluded.updated_at`,
  ).run(id, orgId, body.scopeKind, body.scopeId, body.monthlyUsd, createdBy, Date.now());
  return row(db.query<Raw, [string]>("SELECT * FROM budgets WHERE id = ?").get(id) as Raw);
}

export function deleteBudget(db: Database, orgId: string, id: string): boolean {
  return db.query("DELETE FROM budgets WHERE id = ? AND org_id = ?").run(id, orgId).changes > 0;
}

// The member's own budget, those of its teams and that of its org.
export function budgetsCovering(db: Database, memberId: string): BudgetRow[] {
  return db
    .query<Raw, [string]>(
      `SELECT b.* FROM budgets b WHERE
         (b.scope_kind = 'member' AND b.scope_id = ?1)
         OR (b.scope_kind = 'team' AND b.scope_id IN (SELECT team_id FROM team_members WHERE member_id = ?1))
         OR (b.scope_kind = 'org' AND b.scope_id = (SELECT org_id FROM members WHERE id = ?1))
       ORDER BY b.scope_kind, b.scope_id`,
    )
    .all(memberId)
    .map(row);
}

export const SCOPE_MEMBERS_SQL = {
  org: "SELECT id FROM members WHERE org_id = ?",
  team: "SELECT member_id AS id FROM team_members WHERE team_id = ?",
  member: "SELECT id FROM members WHERE id = ?",
} as const;

export function memberIdsOf(db: Database, scope: { kind: BudgetScopeKind; id: string }): string[] {
  return db
    .query<{ id: string }, [string]>(SCOPE_MEMBERS_SQL[scope.kind])
    .all(scope.id)
    .map((r) => r.id);
}

export function scopeLabel(db: Database, b: BudgetRow): string {
  const sql = {
    org: "SELECT name AS label FROM orgs WHERE id = ?",
    team: "SELECT name AS label FROM teams WHERE id = ?",
    member: "SELECT handle AS label FROM members WHERE id = ?",
  }[b.scopeKind];
  const found = db.query<{ label: string }, [string]>(sql).get(b.scopeId);
  return `${b.scopeKind} ${found?.label ?? b.scopeId}`;
}

// INSERT OR IGNORE on the primary key makes "first crossing this period" atomic.
export function recordAlert(
  db: Database,
  budgetId: string,
  period: string,
  level: BudgetLevel,
): boolean {
  return (
    db
      .query(
        "INSERT OR IGNORE INTO budget_alerts (budget_id, period, level, at) VALUES (?, ?, ?, ?)",
      )
      .run(budgetId, period, level, Date.now()).changes > 0
  );
}

export function scopeOrg(
  db: Database,
  scope: { kind: BudgetScopeKind; id: string },
): string | null {
  const sql = {
    org: "SELECT id AS org FROM orgs WHERE id = ?",
    team: "SELECT org_id AS org FROM teams WHERE id = ?",
    member: "SELECT org_id AS org FROM members WHERE id = ?",
  }[scope.kind];
  return db.query<{ org: string }, [string]>(sql).get(scope.id)?.org ?? null;
}
