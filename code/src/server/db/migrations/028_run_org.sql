-- The org a run acted for, fixed at start. Deriving it later from the member row or the project
-- misplaces a grantee org's runs once the member is removed.
ALTER TABLE runs ADD COLUMN org_id TEXT;

UPDATE runs SET org_id = (SELECT m.org_id FROM members m WHERE m.id = runs.member_id)
  WHERE member_id IS NOT NULL;

-- A run whose member row is already gone keeps a NULL org: guessing the project's org would hand a
-- grantee org's run to the owner org. Org log search skips NULL-org runs; the instance admin still sees them.
CREATE INDEX runs_org ON runs (org_id);
