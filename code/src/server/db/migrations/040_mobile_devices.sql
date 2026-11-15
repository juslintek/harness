PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE oauth_consent_challenges_new AS SELECT * FROM oauth_consent_challenges;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK (method IN ('passkey', 'email', 'recovery', 'enroll', 'mobile')),
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  step_up_at INTEGER,
  revoked_at INTEGER
) STRICT;

INSERT INTO sessions_new (id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at, revoked_at)
SELECT id, user_id, token_hash, method, user_agent, created_at, last_seen_at, expires_at, step_up_at, revoked_at FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_user ON sessions (user_id);

INSERT INTO oauth_consent_challenges SELECT * FROM oauth_consent_challenges_new;
DROP TABLE oauth_consent_challenges_new;

CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  public_key_spki TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_mobile_devices_user ON mobile_devices(user_id);

CREATE TABLE mobile_pair_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE TABLE mobile_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('enroll', 'pair', 'step_up')),
  nonce TEXT NOT NULL,
  user_id TEXT,
  device_id TEXT REFERENCES mobile_devices(id) ON DELETE CASCADE,
  code_hash TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX idx_mobile_challenges_purpose ON mobile_challenges(purpose, expires_at);
