import type { Database } from "bun:sqlite";

export interface PositionRow {
  id: string;
  orgId: string;
  teamId: string | null;
  title: string;
  memberId: string | null;
  reportsTo: string | null;
  isManager: boolean;
  createdAt: number;
}

type Raw = {
  id: string;
  org_id: string;
  team_id: string | null;
  title: string;
  member_id: string | null;
  reports_to: string | null;
  is_manager: number;
  created_at: number;
};

const row = (r: Raw): PositionRow => ({
  id: r.id,
  orgId: r.org_id,
  teamId: r.team_id,
  title: r.title,
  memberId: r.member_id,
  reportsTo: r.reports_to,
  isManager: r.is_manager === 1,
  createdAt: r.created_at,
});

const DEPTH_CAP = 32;

function get(db: Database, id: string): PositionRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM positions WHERE id = ?").get(id);
  return r ? row(r) : null;
}

export interface NewPosition {
  orgId: string;
  teamId?: string;
  title: string;
  memberId?: string;
  reportsTo?: string;
  isManager?: boolean;
}

function checkReportsTo(
  db: Database,
  orgId: string,
  selfId: string,
  reportsTo: string | null,
): void {
  if (reportsTo === null) return;
  const target = get(db, reportsTo);
  if (!target || target.orgId !== orgId)
    throw new Error("reports_to must be a position in the same org");
  for (let at: PositionRow | null = target; at; at = at.reportsTo ? get(db, at.reportsTo) : null) {
    if (at.id === selfId) throw new Error("reports_to would create a cycle");
  }
}

export function createPosition(db: Database, input: NewPosition): PositionRow {
  const id = Bun.randomUUIDv7();
  checkReportsTo(db, input.orgId, id, input.reportsTo ?? null);
  db.query(
    "INSERT INTO positions (id, org_id, team_id, title, member_id, reports_to, is_manager, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.orgId,
    input.teamId ?? null,
    input.title,
    input.memberId ?? null,
    input.reportsTo ?? null,
    input.isManager ? 1 : 0,
    Date.now(),
  );
  return get(db, id) as PositionRow;
}

export interface PositionPatch {
  title?: string;
  teamId?: string | null;
  memberId?: string | null;
  reportsTo?: string | null;
  isManager?: boolean;
}

export function updatePosition(db: Database, id: string, patch: PositionPatch): PositionRow {
  const cur = get(db, id);
  if (!cur) throw new Error(`unknown position: ${id}`);
  const n = { ...cur, ...patch };
  checkReportsTo(db, cur.orgId, id, n.reportsTo);
  db.query(
    "UPDATE positions SET title = ?, team_id = ?, member_id = ?, reports_to = ?, is_manager = ? WHERE id = ?",
  ).run(n.title, n.teamId, n.memberId, n.reportsTo, n.isManager ? 1 : 0, id);
  return get(db, id) as PositionRow;
}

export function listPositions(db: Database, orgId: string): PositionRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM positions WHERE org_id = ? ORDER BY created_at, id")
    .all(orgId)
    .map(row);
}

export function managerPositionsOf(db: Database, memberId: string): PositionRow[] {
  return db
    .query<Raw, [string]>(
      "SELECT * FROM positions WHERE member_id = ? AND is_manager = 1 ORDER BY created_at, id",
    )
    .all(memberId)
    .map(row);
}

export function directReportsOf(db: Database, memberId: string): string[] {
  return db
    .query<{ member_id: string }, [string]>(
      `SELECT DISTINCT sub.member_id FROM positions mine
       JOIN positions sub ON sub.reports_to = mine.id
       WHERE mine.member_id = ? AND sub.member_id IS NOT NULL
       ORDER BY sub.created_at, sub.id`,
    )
    .all(memberId)
    .map((r) => r.member_id);
}

export function reportsTransitivelyTo(
  db: Database,
  memberId: string,
  managerPositionId: string,
): boolean {
  const held = db.query<Raw, [string]>("SELECT * FROM positions WHERE member_id = ?").all(memberId);
  for (const start of held) {
    let at: PositionRow | null = row(start);
    for (let depth = 0; at && depth < DEPTH_CAP; depth++) {
      if (at.reportsTo === managerPositionId) return true;
      at = at.reportsTo ? get(db, at.reportsTo) : null;
    }
  }
  return false;
}
