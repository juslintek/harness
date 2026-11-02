CREATE TABLE events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  run_id TEXT,
  task_id TEXT,
  agent TEXT,
  kind TEXT NOT NULL,
  gen_ai_operation_name TEXT,
  gen_ai_tool_name TEXT,
  gen_ai_conversation_id TEXT,
  gen_ai_request_model TEXT,
  gen_ai_usage_input_tokens INTEGER,
  gen_ai_usage_output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  reported_cost_usd REAL,
  command TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  guard_layer TEXT,
  guard_verdict TEXT,
  guard_rule TEXT,
  source TEXT,
  dedupe_key TEXT UNIQUE,
  segment_id TEXT,
  seg_offset INTEGER,
  seg_len INTEGER
) STRICT;

CREATE INDEX events_run_ts ON events (run_id, ts);
CREATE INDEX events_kind_ts ON events (kind, ts);

CREATE TABLE log_flags (key TEXT PRIMARY KEY, value TEXT) STRICT;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN NOT EXISTS (SELECT 1 FROM log_flags WHERE key = 'retention' AND value = '1')
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_update BEFORE UPDATE OF
  id, ts, run_id, task_id, agent, kind, gen_ai_operation_name, gen_ai_tool_name,
  gen_ai_conversation_id, gen_ai_request_model, gen_ai_usage_input_tokens,
  gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  reported_cost_usd, command, exit_code, duration_ms, guard_layer, guard_verdict,
  guard_rule, source, dedupe_key
ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- REPLACE conflict handling deletes without firing delete triggers, so duplicates are refused here.
CREATE TRIGGER events_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id OR rowid = NEW.rowid)
  OR (NEW.dedupe_key IS NOT NULL AND EXISTS (SELECT 1 FROM events WHERE dedupe_key = NEW.dedupe_key))
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_rowid_update BEFORE UPDATE ON events
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE pending_payloads (
  event_rowid INTEGER PRIMARY KEY,
  run_id TEXT,
  body TEXT NOT NULL
) STRICT;

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  level INTEGER NOT NULL,
  raw_len INTEGER NOT NULL,
  bytes BLOB NOT NULL
) STRICT;

CREATE VIRTUAL TABLE events_fts USING fts5(body, content='', contentless_delete=1, detail=column);
CREATE VIRTUAL TABLE commands_fts USING fts5(text, content='', contentless_delete=1, detail=column, tokenize='trigram');
