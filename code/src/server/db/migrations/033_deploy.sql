-- target is the TargetView JSON as the admin saw it, so approval covers exactly that host.
-- binary_path and binary_sha256 are fixed at request time; the executor refuses a changed file.
CREATE TABLE deploy_requests (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','running','done','failed')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT
) STRICT;
