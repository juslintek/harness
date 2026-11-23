ALTER TABLE wakeups ADD COLUMN not_before INTEGER;
CREATE INDEX idx_wakeups_pending_not_before ON wakeups(status, not_before);
ALTER TABLE agent_accounts ADD COLUMN exhaustion_streak INTEGER NOT NULL DEFAULT 0;
