CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('org', 'team', 'project', 'group', 'dm')),
  name TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  dm_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'team') = (team_id IS NOT NULL)),
  CHECK ((kind = 'project') = (project_id IS NOT NULL)),
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX channels_one_org ON channels (org_id) WHERE kind = 'org';
CREATE UNIQUE INDEX channels_one_team ON channels (team_id) WHERE kind = 'team';
CREATE UNIQUE INDEX channels_one_project ON channels (project_id) WHERE kind = 'project';

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, member_id)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
) STRICT;

CREATE INDEX messages_channel_thread ON messages (channel_id, thread_root_id, created_at);

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, member_id)
) STRICT;

-- No foreign key to tasks: the board slice owns that table and its migration (011) runs
-- before this one, but chat must not depend on board's schema or code. Links are resolved
-- by task number only when the table exists.
CREATE TABLE message_tasks (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  PRIMARY KEY (message_id, task_id)
) STRICT;
