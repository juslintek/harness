CREATE TABLE hire_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- A member id, or user:<id> when a person without a member row asked.
  requested_by TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('interviewing', 'followups', 'answering', 'scoring', 'deciding', 'hired', 'rejected', 'cancelled')),
  phase_started_at INTEGER NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  hired_member_id TEXT,
  onboarding TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX hire_requests_org ON hire_requests(org_id, created_at);

CREATE TABLE hire_candidates (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES hire_requests(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'interviewing', 'answered', 'failed', 'hired', 'rejected')),
  system_score REAL,
  total REAL
) STRICT;

CREATE INDEX hire_candidates_request ON hire_candidates(request_id);

CREATE TABLE interview_questions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES hire_requests(id) ON DELETE CASCADE,
  -- NULL means the question is asked of every candidate.
  candidate_id TEXT,
  -- NULL means the harness asked it.
  asked_by TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('base', 'followup')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX interview_questions_request ON interview_questions(request_id);

CREATE TABLE interview_answers (
  question_id TEXT NOT NULL REFERENCES interview_questions(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES hire_candidates(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (question_id, candidate_id)
) STRICT;

CREATE TABLE hire_reviewers (
  request_id TEXT NOT NULL REFERENCES hire_requests(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  -- 1 once the reviewer is done with follow-ups.
  asked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, member_id)
) STRICT;

CREATE TABLE scorecards (
  candidate_id TEXT NOT NULL REFERENCES hire_candidates(id) ON DELETE CASCADE,
  scorer_id TEXT NOT NULL,
  fit INTEGER NOT NULL CHECK (fit BETWEEN 1 AND 5),
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5),
  honesty INTEGER NOT NULL CHECK (honesty BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, scorer_id)
) STRICT;

ALTER TABLE run_tokens ADD COLUMN candidate_id TEXT;
