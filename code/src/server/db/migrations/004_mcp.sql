CREATE TABLE run_tokens (
  hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX run_tokens_run ON run_tokens (run_id);
