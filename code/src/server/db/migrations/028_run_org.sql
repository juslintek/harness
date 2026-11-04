-- The org a run acted for, fixed at start. Deriving it later from the member row or the project
-- misplaces a grantee org's runs once the member is removed.
ALTER TABLE runs ADD COLUMN org_id TEXT;

UPDATE runs SET org_id = (SELECT m.org_id FROM members m WHERE m.id = runs.member_id)
  WHERE member_id IS NOT NULL;

-- Only for runs whose member row is already gone: the project's org is the best guess left.
UPDATE runs SET org_id = (SELECT p.org_id FROM projects p WHERE p.id = runs.project_id)
  WHERE org_id IS NULL AND member_id IS NOT NULL AND project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = runs.member_id);

CREATE INDEX runs_org ON runs (org_id);
