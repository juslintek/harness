CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('org', 'team', 'member')),
  -- Points at orgs, teams or members by scope_kind, so no foreign key can express it.
  scope_id TEXT NOT NULL,
  monthly_usd REAL NOT NULL CHECK (monthly_usd > 0),
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope_kind, scope_id)
) STRICT;

CREATE TABLE budget_alerts (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('warn', 'pause')),
  at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, period, level)
) STRICT;
