-- seq is the explicit rowid: VACUUM may renumber an implicit one and then notes_fts would point at
-- other notes' text.
CREATE TABLE notes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  disk TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'org', 'project', 'agent')),
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT,
  member_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  source_agent TEXT,
  confidence REAL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  hash TEXT NOT NULL,
  slug TEXT NOT NULL
) STRICT;
CREATE INDEX idx_notes_org_scope ON notes(org_id, scope);
CREATE INDEX idx_notes_slug ON notes(slug);

CREATE TABLE note_links (
  src_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  PRIMARY KEY (src_id, target)
) STRICT;
CREATE INDEX idx_note_links_target ON note_links(target);

CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, tokenize = 'porter unicode61');

CREATE TABLE note_writes (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  disk TEXT NOT NULL,
  org_id TEXT,
  op TEXT NOT NULL,
  actor TEXT NOT NULL,
  member_id TEXT,
  run_id TEXT,
  before_text TEXT,
  after_text TEXT,
  before_hash TEXT,
  after_hash TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_note_writes_org_at ON note_writes(org_id, at);

CREATE TABLE note_reads (
  note_id TEXT NOT NULL,
  run_id TEXT,
  member_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('view', 'search', 'index')),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_note_reads_note ON note_reads(note_id);
