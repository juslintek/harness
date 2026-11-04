import type { Database } from "bun:sqlite";
import type { RunMember } from "./launch";

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
  memberId: string | null;
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
  attempt: number;
  batchId: string | null;
}

interface DbRun {
  id: string;
  task_id: string | null;
  member_id: string | null;
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
  attempt: number;
  batch_id: string | null;
}

export interface NewRun {
  id: string;
  taskId: string | null;
  member?: RunMember | null;
  chargedTo?: string | null | undefined;
  agentId: string;
  model: string | null;
  repo: string;
  prompt: string;
  attempt?: number | undefined;
  batchId?: string | undefined;
}

function toRow(r: DbRun): RunRow {
  return {
    id: r.id,
    taskId: r.task_id,
    memberId: r.member_id,
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
    attempt: r.attempt,
    batchId: r.batch_id,
  };
}

export function insertRun(db: Database, run: NewRun): void {
  db.run(
    "INSERT INTO runs (id, task_id, member_id, project_id, agent_id, model, repo, prompt, state, created_at, attempt, batch_id, charged_to, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
    [
      run.id,
      run.taskId,
      run.member?.memberId ?? null,
      run.member?.projectId ?? null,
      run.agentId,
      run.model,
      run.repo,
      run.prompt,
      Date.now(),
      run.attempt ?? 1,
      run.batchId ?? null,
      run.chargedTo ?? null,
      run.member?.orgId ?? null,
    ],
  );
}

export function worktreeOf(db: Database, runId: string): { worktree: string; branch: string } {
  const run = getRun(db, runId);
  if (!run?.worktree || !run.branch) throw new Error(`run has no worktree to reuse: ${runId}`);
  return { worktree: run.worktree, branch: run.branch };
}

export function listLiveRuns(db: Database): RunRow[] {
  return db
    .query<DbRun, []>("SELECT * FROM runs WHERE state IN ('queued', 'starting', 'running')")
    .all()
    .map(toRow);
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

export function setPid(db: Database, id: string, pid: number, identity: string | null): void {
  db.run("UPDATE runs SET pid = ?, pid_identity = ? WHERE id = ?", [pid, identity, id]);
}

export function listUnendedRuns(
  db: Database,
): Array<{ id: string; pid: number | null; identity: string | null }> {
  return db
    .query<{ id: string; pid: number | null; identity: string | null }, []>(
      "SELECT id, pid, pid_identity AS identity FROM runs WHERE state IN ('queued', 'starting', 'running')",
    )
    .all();
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
