import type { Database } from "bun:sqlite";
import type { Layer, PolicyKey } from "../../../shared/policies";

export interface PolicyContext {
  orgId: string;
  teamId?: string;
  memberId?: string;
  taskId?: string;
}

export interface PolicyRow {
  layer: Layer;
  targetId: string;
  key: PolicyKey;
  value: unknown;
  setBy: string;
}

export function getPolicyRow(
  db: Database,
  layer: Layer,
  targetId: string,
  key: PolicyKey,
): PolicyRow | null {
  const r = db
    .query<{ value: string; set_by: string }, [string, string, string]>(
      "SELECT value, set_by FROM policies WHERE layer = ? AND target_id = ? AND key = ?",
    )
    .get(layer, targetId, key);
  return r ? { layer, targetId, key, value: JSON.parse(r.value), setBy: r.set_by } : null;
}

export function upsertPolicy(db: Database, row: PolicyRow): void {
  db.query(
    `INSERT INTO policies (id, layer, target_id, key, value, set_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (layer, target_id, key)
     DO UPDATE SET value = excluded.value, set_by = excluded.set_by, updated_at = excluded.updated_at`,
  ).run(
    Bun.randomUUIDv7(),
    row.layer,
    row.targetId,
    row.key,
    JSON.stringify(row.value),
    row.setBy,
    Date.now(),
  );
}

export function clearPolicy(db: Database, layer: Layer, targetId: string, key: PolicyKey): void {
  db.query("DELETE FROM policies WHERE layer = ? AND target_id = ? AND key = ?").run(
    layer,
    targetId,
    key,
  );
}

// The queries below only read tables owned by other slices; writes stay in their own slice.
function teamOfMember(db: Database, memberId: string): string | undefined {
  const viaPosition = db
    .query<{ team_id: string }, [string]>(
      "SELECT team_id FROM positions WHERE member_id = ? AND team_id IS NOT NULL ORDER BY created_at, id LIMIT 1",
    )
    .get(memberId);
  if (viaPosition) return viaPosition.team_id;
  return db
    .query<{ team_id: string }, [string]>(
      "SELECT team_id FROM team_members WHERE member_id = ? ORDER BY team_id LIMIT 1",
    )
    .get(memberId)?.team_id;
}

function teamOfTask(db: Database, taskId: string): string | undefined {
  return (
    db
      .query<{ team_id: string | null }, [string]>(
        "SELECT p.team_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
      )
      .get(taskId)?.team_id ?? undefined
  );
}

export function contextForMember(db: Database, memberId: string, taskId?: string): PolicyContext {
  const member = db
    .query<{ org_id: string }, [string]>("SELECT org_id FROM members WHERE id = ?")
    .get(memberId);
  if (!member) throw new Error("unknown member");
  const teamId = (taskId && teamOfTask(db, taskId)) || teamOfMember(db, memberId);
  return {
    orgId: member.org_id,
    memberId,
    ...(teamId ? { teamId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function contextForTask(db: Database, taskId: string): PolicyContext | null {
  const task = db
    .query<{ org_id: string; assignee_id: string | null }, [string]>(
      "SELECT org_id, assignee_id FROM tasks WHERE id = ?",
    )
    .get(taskId);
  if (!task) return null;
  // A project grant lets a member of another org take the task; the task's own org still owns it.
  const assignee = task.assignee_id ? contextForMember(db, task.assignee_id, taskId) : null;
  if (assignee?.orgId === task.org_id) return assignee;
  const teamId = teamOfTask(db, taskId);
  return { orgId: task.org_id, taskId, ...(teamId ? { teamId } : {}) };
}

// The context a row of `layer` for `targetId` is read in, or null when the target is unknown.
export function contextForTarget(
  db: Database,
  layer: Layer,
  targetId: string,
): PolicyContext | null {
  if (layer === "org") {
    return db.query("SELECT 1 FROM orgs WHERE id = ?").get(targetId) ? { orgId: targetId } : null;
  }
  if (layer === "team") {
    const team = db
      .query<{ org_id: string }, [string]>("SELECT org_id FROM teams WHERE id = ?")
      .get(targetId);
    return team ? { orgId: team.org_id, teamId: targetId } : null;
  }
  if (layer === "agent") {
    return db.query("SELECT 1 FROM members WHERE id = ?").get(targetId)
      ? contextForMember(db, targetId)
      : null;
  }
  return layer === "task" ? contextForTask(db, targetId) : null;
}
