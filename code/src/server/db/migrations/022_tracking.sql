CREATE TABLE task_estimates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('planner', 'reviewer')),
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'laya_prior')),
  by_member TEXT,
  rationale TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX task_estimates_task ON task_estimates (task_id, kind, created_at);

CREATE TABLE run_stack (
  run_id TEXT NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (run_id, item)
) STRICT;
