CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, name)
) STRICT;

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  user_id TEXT,
  agent_id TEXT,
  model TEXT,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  specialties TEXT NOT NULL DEFAULT '[]',
  heartbeat_minutes INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, handle),
  UNIQUE (org_id, user_id),
  CHECK (kind <> 'human' OR user_id IS NOT NULL),
  CHECK (kind <> 'agent' OR (agent_id IS NOT NULL AND role IN ('member', 'viewer')))
) STRICT;

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
) STRICT;

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  reports_to TEXT REFERENCES positions(id) ON DELETE SET NULL,
  is_manager INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, key)
) STRICT;

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, org_id)
) STRICT;
