CREATE TABLE oauth_consent_challenges (
  challenge_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER
) STRICT;
