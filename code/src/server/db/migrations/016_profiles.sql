CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  runtime TEXT NOT NULL,
  model TEXT,
  persona TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT '{}',
  fallbacks TEXT NOT NULL DEFAULT '[]',
  card TEXT,
  card_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX profiles_org ON profiles(org_id);

-- Removing a profile must not take its member along.
ALTER TABLE members ADD COLUMN profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;
