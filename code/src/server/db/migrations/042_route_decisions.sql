CREATE TABLE route_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  ts INTEGER NOT NULL,
  policy TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  chosen_account TEXT
);
CREATE INDEX idx_route_decisions_ts ON route_decisions(ts);
CREATE INDEX idx_route_decisions_run ON route_decisions(run_id);
