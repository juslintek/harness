-- The pin is (issuer, sub), not the provider row id: deleting and re-adding a provider with the
-- same issuer must not lock pinned users out. Pins whose provider is already gone have no issuer
-- to carry over and are dropped; those users pin again on their next OIDC login.
CREATE TABLE oidc_identities_new (
  user_id TEXT PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (issuer, sub)
) STRICT;

INSERT OR IGNORE INTO oidc_identities_new (user_id, issuer, sub, created_at)
SELECT i.user_id, p.issuer, i.sub, i.created_at
FROM oidc_identities i JOIN oidc_providers p ON p.id = i.provider_id;

DROP TABLE oidc_identities;
ALTER TABLE oidc_identities_new RENAME TO oidc_identities;
