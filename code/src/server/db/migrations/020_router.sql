ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN batch_id TEXT;

-- One handoff per failed run: the unique key is what makes two racing failovers produce one next attempt.
CREATE TABLE run_handoffs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  member_id TEXT REFERENCES members (id) ON DELETE SET NULL,
  from_run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  to_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_run_id)
) STRICT;
