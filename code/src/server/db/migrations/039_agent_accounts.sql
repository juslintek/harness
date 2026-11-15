-- Several logins per runtime. `home` NULL means the CLI's own default home. No foreign keys:
-- account ids are code-defined and runs, quota rows and events must outlive a removed account.
CREATE TABLE agent_accounts (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key')),
  label TEXT NOT NULL,
  home TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('unknown', 'pending', 'active', 'logged_out', 'probe_failed', 'disabled', 'removing', 'removed')),
  identity_hint TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  priority INTEGER NOT NULL DEFAULT 0,
  exhausted_until INTEGER,
  last_probe_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (runtime, label)
) STRICT;

-- A run can exist for a runtime that was never linked, so both tables feed the defaults.
INSERT INTO agent_accounts
  (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
SELECT 'default:' || runtime, runtime, 'login', 'default', NULL, 'unknown',
  CASE runtime WHEN 'codex' THEN 1 ELSE 2 END,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (SELECT agent_id AS runtime FROM agent_links UNION SELECT agent_id FROM runs);

ALTER TABLE runs ADD COLUMN account_id TEXT;
UPDATE runs SET account_id = 'default:' || agent_id;

ALTER TABLE quota_snapshots ADD COLUMN account_id TEXT;
CREATE INDEX quota_snapshots_account ON quota_snapshots (account_id, window, ts);
-- provider is any string POST /api/quota accepts, so only rows with a matching account are tagged.
UPDATE quota_snapshots SET account_id = 'default:' || provider
WHERE EXISTS (SELECT 1 FROM agent_accounts WHERE id = 'default:' || quota_snapshots.provider);

-- History stays NULL and is read as COALESCE(account_id, 'default:' || agent).
ALTER TABLE events ADD COLUMN account_id TEXT;
DROP TRIGGER events_no_update;
CREATE TRIGGER events_no_update BEFORE UPDATE OF
  id, ts, run_id, task_id, agent, kind, gen_ai_operation_name, gen_ai_tool_name,
  gen_ai_conversation_id, gen_ai_request_model, gen_ai_usage_input_tokens,
  gen_ai_usage_output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  reported_cost_usd, command, exit_code, duration_ms, guard_layer, guard_verdict,
  guard_rule, source, dedupe_key, account_id
ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
