import type { Database } from "bun:sqlite";

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "killed";

export interface RunRow {
  id: string;
  taskId: string | null;
  agentId: string;
  model: string | null;
  repo: string;
  worktree: string | null;
  branch: string | null;
  prompt: string;
  state: RunState;
  reason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

interface DbRun {
  id: string;
  task_id: string | null;
  agent_id: string;
  model: string | null;
  repo: string;
  worktree: string | null;
  branch: string | null;
  prompt: string;
  state: RunState;
  reason: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface NewRun {
  id: string;
  taskId: string | null;
  agentId: string;
  model: string | null;
  repo: string;
  prompt: string;
}

function toRow(r: DbRun): RunRow {
  return {
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    model: r.model,
    repo: r.repo,
    worktree: r.worktree,
    branch: r.branch,
    prompt: r.prompt,
    state: r.state,
    reason: r.reason,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export function insertRun(db: Database, run: NewRun): void {
  db.run(
    "INSERT INTO runs (id, task_id, agent_id, model, repo, prompt, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
    [run.id, run.taskId, run.agentId, run.model, run.repo, run.prompt, Date.now()],
  );
}

export function setStarting(
  db: Database,
  id: string,
  worktree: string | null,
  branch: string | null,
): void {
  db.run("UPDATE runs SET worktree = ?, branch = ?, state = 'starting' WHERE id = ?", [
    worktree,
    branch,
    id,
  ]);
}

export function markRunning(db: Database, id: string): void {
  db.run("UPDATE runs SET state = 'running', started_at = ? WHERE id = ?", [Date.now(), id]);
}

export function markEnded(db: Database, id: string, state: RunState, reason: string | null): void {
  db.run("UPDATE runs SET state = ?, reason = ?, ended_at = ? WHERE id = ?", [
    state,
    reason,
    Date.now(),
    id,
  ]);
}

export function getRun(db: Database, id: string): RunRow | null {
  const row = db.query<DbRun, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
  return row ? toRow(row) : null;
}

export function listRuns(db: Database, limit = 50): RunRow[] {
  return db
    .query<DbRun, [number]>("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit)
    .map(toRow);
}

export function failLiveRuns(db: Database, reason: string): number {
  return db.run(
    "UPDATE runs SET state = 'failed', reason = ?, ended_at = ? WHERE state IN ('queued', 'starting', 'running')",
    [reason, Date.now()],
  ).changes;
}

export function getFlag(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM instance_flags WHERE key = ?")
    .get(key);
  return row ? row.value : null;
}

export function setFlag(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO instance_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function hasExpiredApproval(db: Database, runId: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM approvals WHERE run_id = ? AND status = 'expired'",
    )
    .get(runId);
  return (row?.n ?? 0) > 0;
}
