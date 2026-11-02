CREATE TABLE tail_offsets (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  mtime INTEGER NOT NULL
) STRICT;

CREATE TABLE quota_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  window TEXT NOT NULL,
  used_percent REAL,
  resets_at INTEGER,
  source TEXT NOT NULL,
  ts INTEGER NOT NULL
) STRICT;

CREATE INDEX quota_snapshots_latest ON quota_snapshots (provider, window, ts);
