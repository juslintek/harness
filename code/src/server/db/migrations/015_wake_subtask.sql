CREATE TABLE wakeups_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('assignment', 'comment', 'mention', 'laya_mention', 'subtask', 'schedule', 'run_now')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_id TEXT,
  detail TEXT,
  caused_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'done', 'failed', 'skipped')),
  run_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
) STRICT;

INSERT INTO wakeups_new SELECT id, member_id, reason, task_id, channel_id, message_id, detail, caused_by,
  status, run_id, created_at, started_at, ended_at FROM wakeups;
DROP TABLE wakeups;
ALTER TABLE wakeups_new RENAME TO wakeups;

CREATE INDEX wakeups_member_status ON wakeups (member_id, status);
CREATE INDEX wakeups_member_created ON wakeups (member_id, created_at);
CREATE INDEX wakeups_started ON wakeups (run_id) WHERE status = 'started';
