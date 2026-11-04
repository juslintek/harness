CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('harness', 'org', 'team', 'agent', 'task')),
  target_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (layer, target_id, key)
) STRICT;

CREATE TABLE policy_proposals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  layer TEXT NOT NULL,
  target_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  decided_by TEXT,
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;

CREATE INDEX policy_proposals_org ON policy_proposals (org_id, status);

CREATE TABLE policy_reviews (
  proposal_id TEXT NOT NULL REFERENCES policy_proposals (id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
  comment TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, reviewer_id)
) STRICT;

CREATE TABLE policy_review_requests (
  proposal_id TEXT NOT NULL REFERENCES policy_proposals (id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  PRIMARY KEY (proposal_id, reviewer_id)
) STRICT;
