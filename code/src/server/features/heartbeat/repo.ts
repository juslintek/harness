import type { Database } from "bun:sqlite";
import type { WakeReason, WakeStatus, WakeupView } from "../../../shared/heartbeat";

type Raw = Record<string, string | number | null>;

export interface NewWake {
  memberId: string;
  reason: WakeReason;
  taskId?: string | undefined;
  channelId?: string | undefined;
  messageId?: string | undefined;
  detail?: unknown;
  causedBy: string | null;
  status?: WakeStatus;
}

export type WakeRow = WakeupView;

function parse(json: string | null): unknown {
  try {
    return json === null ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

const wakeRow = (r: Raw): WakeRow => ({
  id: r.id as string,
  memberId: r.member_id as string,
  reason: r.reason as WakeReason,
  taskId: r.task_id as string | null,
  taskNumber: null,
  channelId: r.channel_id as string | null,
  channelName: null,
  messageId: r.message_id as string | null,
  detail: parse(r.detail as string | null),
  causedBy: r.caused_by as string | null,
  status: r.status as WakeStatus,
  runId: r.run_id as string | null,
  createdAt: r.created_at as number,
  startedAt: r.started_at as number | null,
  endedAt: r.ended_at as number | null,
});

export function insertWake(db: Database, w: NewWake): string {
  const id = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO wakeups (id, member_id, reason, task_id, channel_id, message_id, detail, caused_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    w.memberId,
    w.reason,
    w.taskId ?? null,
    w.channelId ?? null,
    w.messageId ?? null,
    w.detail === undefined ? null : JSON.stringify(w.detail),
    w.causedBy,
    w.status ?? "pending",
    Date.now(),
  );
  return id;
}

export function startedRunsSince(db: Database, memberId: string, since: number): number {
  return (
    db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(DISTINCT run_id) AS n FROM wakeups WHERE member_id = ? AND started_at > ?",
      )
      .get(memberId, since)?.n ?? 0
  );
}

export function membersWithPending(db: Database): string[] {
  return db
    .query<{ member_id: string }, []>(
      "SELECT DISTINCT member_id FROM wakeups WHERE status = 'pending'",
    )
    .all()
    .map((r) => r.member_id);
}

// The runs table is the truth: a started wake whose run has ended no longer blocks the member,
// even if the end event never reached us. A started wake without a run id is mid-launch.
export function hasLiveWake(db: Database, memberId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM wakeups w LEFT JOIN runs r ON r.id = w.run_id
         WHERE w.member_id = ? AND w.status = 'started'
           AND (w.run_id IS NULL OR (r.id IS NOT NULL AND r.ended_at IS NULL)) LIMIT 1`,
      )
      .get(memberId) !== null
  );
}

export function endedStartedRuns(db: Database): string[] {
  return db
    .query<{ run_id: string }, []>(
      `SELECT DISTINCT w.run_id AS run_id FROM wakeups w LEFT JOIN runs r ON r.id = w.run_id
       WHERE w.status = 'started' AND w.run_id IS NOT NULL AND (r.id IS NULL OR r.ended_at IS NOT NULL)`,
    )
    .all()
    .map((r) => r.run_id);
}

export function pendingWakes(db: Database, memberId: string): WakeRow[] {
  return db
    .query<Raw, [string]>(
      "SELECT * FROM wakeups WHERE member_id = ? AND status = 'pending' ORDER BY created_at, id",
    )
    .all(memberId)
    .map(wakeRow);
}

function inList(ids: string[]): string {
  return ids.map(() => "?").join(", ");
}

export function setStatus(
  db: Database,
  ids: string[],
  status: WakeStatus,
  extra: { runId?: string; detail?: Record<string, unknown> } = {},
): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const patch = extra.detail === undefined ? null : JSON.stringify(extra.detail);
  db.query(
    `UPDATE wakeups SET status = ?,
       run_id = COALESCE(?, run_id),
       detail = CASE WHEN ? IS NULL THEN detail ELSE json_patch(COALESCE(detail, '{}'), ?) END,
       started_at = CASE WHEN ? = 'started' THEN ? WHEN ? = 'pending' THEN NULL ELSE started_at END,
       ended_at = CASE WHEN ? IN ('done', 'failed', 'skipped') THEN ? ELSE NULL END
     WHERE id IN (${inList(ids)})`,
  ).run(status, extra.runId ?? null, patch, patch, status, now, status, status, now, ...ids);
}

// A restart loses every live run, so wakes still marked started can never be settled by an event.
export function failStartedWakes(db: Database): void {
  db.query("UPDATE wakeups SET status = 'failed', ended_at = ? WHERE status = 'started'").run(
    Date.now(),
  );
}

export function wakesOfRun(db: Database, runId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM wakeups WHERE run_id = ? AND status = 'started'",
    )
    .all(runId)
    .map((r) => r.id);
}

export interface ScheduleDue {
  id: string;
  minutes: number;
  last: number;
}

export function scheduleCandidates(db: Database): ScheduleDue[] {
  return db
    .query<{ id: string; minutes: number; last: number }, []>(
      `SELECT m.id AS id, m.heartbeat_minutes AS minutes,
         COALESCE((SELECT MAX(w.created_at) FROM wakeups w WHERE w.member_id = m.id), m.created_at) AS last
       FROM members m
       WHERE m.heartbeat_minutes IS NOT NULL AND m.kind = 'agent' AND m.paused = 0
         AND m.role != 'viewer'`,
    )
    .all();
}

export function listWakeups(db: Database, orgId: string, limit: number): WakeupView[] {
  return db
    .query<Raw, [string, number]>(
      `SELECT w.* FROM wakeups w JOIN members m ON m.id = w.member_id
       WHERE m.org_id = ? ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
    )
    .all(orgId, limit)
    .map(wakeRow);
}
