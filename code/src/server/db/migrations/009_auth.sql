CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  instance_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  user_id TEXT,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK (method IN ('passkey', 'email', 'recovery', 'enroll')),
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  step_up_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
) STRICT;

CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX email_codes_email ON email_codes (email, created_at);

CREATE TABLE enrollments (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users ON DELETE CASCADE,
  email TEXT,
  redeemed_user_id TEXT REFERENCES users ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
