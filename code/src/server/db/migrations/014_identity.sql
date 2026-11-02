ALTER TABLE run_tokens ADD COLUMN member_id TEXT;
ALTER TABLE run_tokens ADD COLUMN org_id TEXT;
ALTER TABLE runs ADD COLUMN member_id TEXT;
ALTER TABLE runs ADD COLUMN project_id TEXT;
