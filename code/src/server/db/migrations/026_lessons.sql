CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT,
  author_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  run_id TEXT,
  body TEXT NOT NULL,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewer_id TEXT,
  reason TEXT,
  note_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;

CREATE INDEX lessons_org_status ON lessons (org_id, status);
