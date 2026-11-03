-- models.dev prices are USD per million tokens, copied as published.
CREATE TABLE model_registry (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input_usd_mtok REAL NOT NULL,
  output_usd_mtok REAL NOT NULL,
  cache_read_usd_mtok REAL,
  context_window INTEGER,
  tool_call INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
) STRICT;

CREATE TABLE task_triage (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL,
  task_type TEXT NOT NULL,
  specialty TEXT,
  size TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('laya', 'fallback')),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
