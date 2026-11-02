CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  model TEXT,
  repo TEXT NOT NULL,
  worktree TEXT,
  branch TEXT,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL,
  l1 TEXT NOT NULL,
  l2 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;

CREATE INDEX approvals_status_expires ON approvals (status, expires_at);

CREATE TABLE instance_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
