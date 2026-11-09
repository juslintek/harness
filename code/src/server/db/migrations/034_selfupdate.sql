CREATE TABLE update_requests (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','awaiting_approval','checking','building','verifying','swapping','done','rolled_back','failed','denied')),
  reason TEXT,
  flagged_paths TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  log TEXT NOT NULL DEFAULT ''
) STRICT;
