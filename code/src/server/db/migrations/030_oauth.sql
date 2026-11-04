CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

-- A family is every token descended from one code (or one local link); revoking it kills them all.
CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  family TEXT NOT NULL
) STRICT;
CREATE INDEX oauth_tokens_family ON oauth_tokens (family);
CREATE INDEX oauth_tokens_member ON oauth_tokens (member_id);
