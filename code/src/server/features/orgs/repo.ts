import type { Database } from "bun:sqlite";
import { handleSchema, type MemberView, type OrgView, type Role } from "../../../shared/orgs";
import type { PersonRef } from "../../../shared/people";

export interface MemberRow extends MemberView {
  createdAt: number;
}
export interface TeamRow {
  id: string;
  orgId: string;
  name: string;
  createdAt: number;
}
type Raw = Record<string, string | number | null>;

const orgView = (r: Raw): OrgView => ({
  id: r.id as string,
  slug: r.slug as string,
  name: r.name as string,
  createdAt: r.created_at as number,
});
const memberRow = (r: Raw): MemberRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  kind: r.kind as MemberRow["kind"],
  userId: r.user_id as string | null,
  agentId: r.agent_id as string | null,
  model: r.model as string | null,
  handle: r.handle as string,
  displayName: r.display_name as string,
  role: r.role as Role,
  specialties: JSON.parse(r.specialties as string) as string[],
  heartbeatMinutes: r.heartbeat_minutes as number | null,
  paused: r.paused === 1,
  createdAt: r.created_at as number,
});
const teamRow = (r: Raw): TeamRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  name: r.name as string,
  createdAt: r.created_at as number,
});
const orgCreated = new Set<(db: Database, org: OrgView, owner: MemberRow) => void>();
const memberRemoved = new Set<(db: Database, member: MemberRow) => void>();

export function onOrgCreated(
  fn: (db: Database, org: OrgView, owner: MemberRow) => void,
): () => void {
  orgCreated.add(fn);
  return () => orgCreated.delete(fn);
}
export function onMemberRemoved(fn: (db: Database, member: MemberRow) => void): () => void {
  memberRemoved.add(fn);
  return () => memberRemoved.delete(fn);
}

export interface NewOrg {
  name: string;
  slug: string;
  ownerUserId: string;
  ownerName: string;
  ownerHandle: string;
}

export function createOrg(db: Database, input: NewOrg): OrgView {
  handleSchema.parse(input.slug);
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  const owner = db.transaction(() => {
    db.query("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      input.slug,
      input.name,
      now,
    );
    createTeam(db, id, "Core");
    return addHumanMember(db, id, input.ownerUserId, input.ownerHandle, input.ownerName, "owner");
  })();
  const org = { id, slug: input.slug, name: input.name, createdAt: now };
  for (const fn of orgCreated) fn(db, org, owner);
  return org;
}

export function listOrgsForUser(db: Database, userId: string): OrgView[] {
  return db
    .query<Raw, [string]>(
      "SELECT o.* FROM orgs o JOIN members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at, o.id",
    )
    .all(userId)
    .map(orgView);
}

export function getOrgBySlug(db: Database, slug: string): OrgView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM orgs WHERE slug = ?").get(slug);
  return r ? orgView(r) : null;
}

export function getOrg(db: Database, id: string): OrgView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM orgs WHERE id = ?").get(id);
  return r ? orgView(r) : null;
}

export function getMember(db: Database, id: string): MemberRow | null {
  const r = db.query<Raw, [string]>("SELECT * FROM members WHERE id = ?").get(id);
  return r ? memberRow(r) : null;
}
export function personOf(db: Database, id: string | null): PersonRef | null {
  const m = id === null ? null : getMember(db, id);
  return m ? { handle: m.handle, displayName: m.displayName, kind: m.kind } : null;
}
export function memberForUser(db: Database, orgId: string, userId: string): MemberRow | null {
  const r = db
    .query<Raw, [string, string]>("SELECT * FROM members WHERE org_id = ? AND user_id = ?")
    .get(orgId, userId);
  return r ? memberRow(r) : null;
}
export function findMemberByHandle(db: Database, orgId: string, handle: string): MemberRow | null {
  const r = db
    .query<Raw, [string, string]>("SELECT * FROM members WHERE org_id = ? AND handle = ?")
    .get(orgId, handle);
  return r ? memberRow(r) : null;
}
export function findMembersByHandle(db: Database, handle: string): MemberRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM members WHERE handle = ? ORDER BY created_at, id")
    .all(handle)
    .map(memberRow);
}
export function listMembers(db: Database, orgId: string): MemberRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM members WHERE org_id = ? ORDER BY created_at, id")
    .all(orgId)
    .map(memberRow);
}

function insertMember(
  db: Database,
  orgId: string,
  f: Partial<MemberRow> & Pick<MemberRow, "kind" | "handle" | "displayName" | "role">,
): MemberRow {
  handleSchema.parse(f.handle);
  const id = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO members (id, org_id, kind, user_id, agent_id, model, handle, display_name, role, specialties, heartbeat_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    orgId,
    f.kind,
    f.userId ?? null,
    f.agentId ?? null,
    f.model ?? null,
    f.handle,
    f.displayName,
    f.role,
    JSON.stringify(f.specialties ?? []),
    f.heartbeatMinutes ?? null,
    Date.now(),
  );
  return getMember(db, id) as MemberRow;
}

export function addHumanMember(
  db: Database,
  orgId: string,
  userId: string,
  handle: string,
  displayName: string,
  role: Role,
): MemberRow {
  return insertMember(db, orgId, { kind: "human", userId, handle, displayName, role });
}

export interface NewAgentMember {
  agentId: string;
  model?: string;
  handle: string;
  displayName: string;
  specialties: string[];
  heartbeatMinutes?: number;
}
export function addAgentMember(db: Database, orgId: string, input: NewAgentMember): MemberRow {
  return insertMember(db, orgId, { ...input, kind: "agent", role: "member" });
}

export interface MemberPatch {
  displayName?: string;
  role?: Role;
  model?: string | null;
  specialties?: string[];
  heartbeatMinutes?: number | null;
  paused?: boolean;
}
export function updateMember(db: Database, id: string, patch: MemberPatch): MemberRow {
  const cur = getMember(db, id);
  if (!cur) throw new Error(`unknown member: ${id}`);
  const n = { ...cur, ...patch };
  db.query(
    "UPDATE members SET display_name = ?, role = ?, model = ?, specialties = ?, heartbeat_minutes = ?, paused = ? WHERE id = ?",
  ).run(
    n.displayName,
    n.role,
    n.model,
    JSON.stringify(n.specialties),
    n.heartbeatMinutes,
    n.paused ? 1 : 0,
    id,
  );
  return getMember(db, id) as MemberRow;
}

export function removeMember(db: Database, id: string): void {
  const cur = getMember(db, id);
  if (!cur) return;
  db.query("DELETE FROM members WHERE id = ?").run(id);
  for (const fn of memberRemoved) fn(db, cur);
}

export function createTeam(db: Database, orgId: string, name: string): TeamRow {
  const id = Bun.randomUUIDv7();
  db.query("INSERT INTO teams (id, org_id, name, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    orgId,
    name,
    Date.now(),
  );
  return teamRow(db.query<Raw, [string]>("SELECT * FROM teams WHERE id = ?").get(id) as Raw);
}
export function listTeams(db: Database, orgId: string): TeamRow[] {
  return db
    .query<Raw, [string]>("SELECT * FROM teams WHERE org_id = ? ORDER BY created_at, id")
    .all(orgId)
    .map(teamRow);
}
export function addToTeam(db: Database, teamId: string, memberId: string): void {
  db.query("INSERT OR IGNORE INTO team_members (team_id, member_id) VALUES (?, ?)").run(
    teamId,
    memberId,
  );
}
export function removeFromTeam(db: Database, teamId: string, memberId: string): void {
  db.query("DELETE FROM team_members WHERE team_id = ? AND member_id = ?").run(teamId, memberId);
}
