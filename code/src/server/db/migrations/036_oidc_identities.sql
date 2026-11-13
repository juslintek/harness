-- One pinned (provider, sub) per user, set on the first OIDC login. No foreign key to
-- oidc_providers: deleting and re-adding a provider must not release the pin.
CREATE TABLE oidc_identities (
  user_id TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
