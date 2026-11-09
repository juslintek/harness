-- Federation: last-writer-wins metadata on every replicated table, a dirty log fed by
-- triggers, and the change feed. Only rows of a shared project or a remote copy are captured.

ALTER TABLE orgs ADD COLUMN origin_instance TEXT;
ALTER TABLE orgs ADD COLUMN hlc TEXT;
ALTER TABLE members ADD COLUMN origin_instance TEXT;
ALTER TABLE members ADD COLUMN hlc TEXT;
ALTER TABLE projects ADD COLUMN origin_instance TEXT;
ALTER TABLE projects ADD COLUMN hlc TEXT;
ALTER TABLE grants ADD COLUMN origin_instance TEXT;
ALTER TABLE grants ADD COLUMN hlc TEXT;
ALTER TABLE tasks ADD COLUMN origin_instance TEXT;
ALTER TABLE tasks ADD COLUMN hlc TEXT;
ALTER TABLE task_deps ADD COLUMN origin_instance TEXT;
ALTER TABLE task_deps ADD COLUMN hlc TEXT;
ALTER TABLE comments ADD COLUMN origin_instance TEXT;
ALTER TABLE comments ADD COLUMN hlc TEXT;
ALTER TABLE channels ADD COLUMN origin_instance TEXT;
ALTER TABLE channels ADD COLUMN hlc TEXT;
ALTER TABLE messages ADD COLUMN origin_instance TEXT;
ALTER TABLE messages ADD COLUMN hlc TEXT;
ALTER TABLE notes ADD COLUMN origin_instance TEXT;
ALTER TABLE notes ADD COLUMN hlc TEXT;
ALTER TABLE orgs ADD COLUMN home_instance TEXT;
ALTER TABLE projects ADD COLUMN home_instance TEXT;

-- project_id is resolved by the trigger so a delete can still be routed after the row is gone.
CREATE TABLE fed_dirty (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'del')),
  project_id TEXT,
  PRIMARY KEY (table_name, row_id)
) STRICT;

CREATE TABLE fed_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'del')),
  hlc TEXT NOT NULL,
  origin_instance TEXT NOT NULL,
  data TEXT
) STRICT;

-- A deleted row has no hlc of its own. Without this a late put older than the delete would
-- bring the row back.
CREATE TABLE fed_tombstones (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  origin_instance TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
) STRICT;

CREATE TABLE fed_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT INTO fed_state (key, value) VALUES ('applying', '0');

-- Projects that replicate: shared with an org of another instance, or a copy of a remote one.
CREATE VIEW fed_live AS
SELECT p.id FROM projects p
WHERE p.home_instance IS NOT NULL
   OR EXISTS (SELECT 1 FROM grants g JOIN orgs o ON o.id = g.org_id
              WHERE g.project_id = p.id AND o.home_instance IS NOT NULL);

-- Orgs that take part in a replicating project (owner and grantees), to route org and member edits.
CREATE VIEW fed_scope AS
SELECT p.id AS project_id, p.org_id AS org_id FROM projects p WHERE p.id IN (SELECT id FROM fed_live)
UNION
SELECT g.project_id, g.org_id FROM grants g WHERE g.project_id IN (SELECT id FROM fed_live);

CREATE TRIGGER fed_orgs_i AFTER INSERT ON orgs
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = NEW.id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('orgs', NEW.id, 'put', NULL); END;

CREATE TRIGGER fed_orgs_u AFTER UPDATE ON orgs
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = NEW.id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('orgs', NEW.id, 'put', NULL); END;

CREATE TRIGGER fed_orgs_d AFTER DELETE ON orgs
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = OLD.id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('orgs', OLD.id, 'del', NULL); END;

CREATE TRIGGER fed_members_i AFTER INSERT ON members
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = NEW.org_id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('members', NEW.id, 'put', NULL); END;

CREATE TRIGGER fed_members_u AFTER UPDATE ON members
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = NEW.org_id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('members', NEW.id, 'put', NULL); END;

CREATE TRIGGER fed_members_d AFTER DELETE ON members
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND EXISTS (SELECT 1 FROM fed_scope WHERE org_id = OLD.org_id)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('members', OLD.id, 'del', NULL); END;

CREATE TRIGGER fed_projects_i AFTER INSERT ON projects
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('projects', NEW.id, 'put', NEW.id); END;

CREATE TRIGGER fed_projects_u AFTER UPDATE ON projects
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('projects', NEW.id, 'put', NEW.id); END;

CREATE TRIGGER fed_projects_d AFTER DELETE ON projects
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND OLD.id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('projects', OLD.id, 'del', OLD.id); END;

CREATE TRIGGER fed_grants_i AFTER INSERT ON grants
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('grants', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_grants_u AFTER UPDATE ON grants
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('grants', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_grants_d AFTER DELETE ON grants
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND OLD.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('grants', OLD.id, 'del', OLD.project_id); END;

CREATE TRIGGER fed_tasks_i AFTER INSERT ON tasks
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('tasks', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_tasks_u AFTER UPDATE ON tasks
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('tasks', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_tasks_d AFTER DELETE ON tasks
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND OLD.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('tasks', OLD.id, 'del', OLD.project_id); END;

CREATE TRIGGER fed_task_deps_i AFTER INSERT ON task_deps
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = NEW.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('task_deps', NEW.task_id || ':' || NEW.depends_on, 'put', (SELECT project_id FROM tasks WHERE id = NEW.task_id)); END;

CREATE TRIGGER fed_task_deps_u AFTER UPDATE ON task_deps
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = NEW.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('task_deps', NEW.task_id || ':' || NEW.depends_on, 'put', (SELECT project_id FROM tasks WHERE id = NEW.task_id)); END;

CREATE TRIGGER fed_task_deps_d AFTER DELETE ON task_deps
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = OLD.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('task_deps', OLD.task_id || ':' || OLD.depends_on, 'del', (SELECT project_id FROM tasks WHERE id = OLD.task_id)); END;

CREATE TRIGGER fed_comments_i AFTER INSERT ON comments
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = NEW.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('comments', NEW.id, 'put', (SELECT project_id FROM tasks WHERE id = NEW.task_id)); END;

CREATE TRIGGER fed_comments_u AFTER UPDATE ON comments
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = NEW.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('comments', NEW.id, 'put', (SELECT project_id FROM tasks WHERE id = NEW.task_id)); END;

CREATE TRIGGER fed_comments_d AFTER DELETE ON comments
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM tasks WHERE id = OLD.task_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('comments', OLD.id, 'del', (SELECT project_id FROM tasks WHERE id = OLD.task_id)); END;

CREATE TRIGGER fed_channels_i AFTER INSERT ON channels
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('channels', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_channels_u AFTER UPDATE ON channels
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND NEW.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('channels', NEW.id, 'put', NEW.project_id); END;

CREATE TRIGGER fed_channels_d AFTER DELETE ON channels
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND OLD.project_id IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('channels', OLD.id, 'del', OLD.project_id); END;

CREATE TRIGGER fed_messages_i AFTER INSERT ON messages
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM channels WHERE id = NEW.channel_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('messages', NEW.id, 'put', (SELECT project_id FROM channels WHERE id = NEW.channel_id)); END;

CREATE TRIGGER fed_messages_u AFTER UPDATE ON messages
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM channels WHERE id = NEW.channel_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('messages', NEW.id, 'put', (SELECT project_id FROM channels WHERE id = NEW.channel_id)); END;

CREATE TRIGGER fed_messages_d AFTER DELETE ON messages
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND (SELECT project_id FROM channels WHERE id = OLD.channel_id) IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('messages', OLD.id, 'del', (SELECT project_id FROM channels WHERE id = OLD.channel_id)); END;

CREATE TRIGGER fed_notes_i AFTER INSERT ON notes
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND CASE WHEN NEW.scope = 'project' THEN NEW.project_id END IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('notes', NEW.id, 'put', CASE WHEN NEW.scope = 'project' THEN NEW.project_id END); END;

CREATE TRIGGER fed_notes_u AFTER UPDATE ON notes
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND CASE WHEN NEW.scope = 'project' THEN NEW.project_id END IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('notes', NEW.id, 'put', CASE WHEN NEW.scope = 'project' THEN NEW.project_id END); END;

CREATE TRIGGER fed_notes_d AFTER DELETE ON notes
WHEN (SELECT value FROM fed_state WHERE key = 'applying') = '0' AND CASE WHEN OLD.scope = 'project' THEN OLD.project_id END IN (SELECT id FROM fed_live)
BEGIN INSERT OR REPLACE INTO fed_dirty (table_name, row_id, op, project_id) VALUES ('notes', OLD.id, 'del', CASE WHEN OLD.scope = 'project' THEN OLD.project_id END); END;

-- Paired instances. A revoked peer keeps its row so the UI can show it and a re-pair is explicit.
CREATE TABLE peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  public_key TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;

-- Only the sha256 of an invite token is stored; the token itself is shown once.
CREATE TABLE fed_invites (
  hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE TABLE fed_nonces (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) STRICT;
