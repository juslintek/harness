CREATE TABLE notify_targets (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('push', 'email', 'slack', 'telegram', 'webhook')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notify_targets_member ON notify_targets (member_id, channel);

CREATE TABLE notify_prefs (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (member_id, channel, kind)
) STRICT;

CREATE TABLE notify_log (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  member_id TEXT,
  channel TEXT,
  kind TEXT,
  tag TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'dropped')),
  reason TEXT,
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX notify_log_dedupe ON notify_log (tag, target_id, at);

CREATE TABLE notify_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE bridges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slack', 'telegram')),
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, external_id)
) STRICT;

CREATE TABLE bridge_users (
  kind TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, external_user_id)
) STRICT;
