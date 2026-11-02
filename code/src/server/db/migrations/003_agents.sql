CREATE TABLE agent_links (
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE agent_models (
  agent_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, model_id)
) STRICT;
