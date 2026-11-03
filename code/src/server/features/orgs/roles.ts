import type { Database } from "bun:sqlite";
import type { Role } from "../../../shared/orgs";
import { getProject } from "./projects";
import { getMember, type MemberRow } from "./repo";

export type Access = "none" | "read" | "write" | "admin";

const rank: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const accessRank: Record<Access, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return rank[role] >= rank[min];
}

const byRole: Record<Role, Access> = {
  viewer: "read",
  member: "write",
  admin: "admin",
  owner: "admin",
};

export function orgAccess(db: Database, userId: string, orgId: string): Role | null {
  const row = db
    .query<{ role: Role }, [string, string]>(
      "SELECT role FROM members WHERE org_id = ? AND user_id = ?",
    )
    .get(orgId, userId);
  return row?.role ?? null;
}

function memberRoles(
  db: Database,
  who: string | { memberId: string },
): { orgId: string; role: Role }[] {
  const rows =
    typeof who === "string"
      ? db
          .query<{ org_id: string; role: Role }, [string]>(
            "SELECT org_id, role FROM members WHERE user_id = ?",
          )
          .all(who)
      : db
          .query<{ org_id: string; role: Role }, [string]>(
            "SELECT org_id, role FROM members WHERE id = ?",
          )
          .all(who.memberId);
  return rows.map((r) => ({ orgId: r.org_id, role: r.role }));
}

function minAccess(a: Access, b: Access): Access {
  return accessRank[a] <= accessRank[b] ? a : b;
}

export function projectAccess(
  db: Database,
  who: string | { memberId: string },
  projectId: string,
): Access {
  const project = getProject(db, projectId);
  if (!project) return "none";
  let best: Access = "none";
  for (const { orgId, role } of memberRoles(db, who)) {
    let access: Access = "none";
    if (orgId === project.orgId) access = byRole[role];
    else {
      const grant = db
        .query<{ permission: "read" | "write" }, [string, string]>(
          "SELECT permission FROM grants WHERE project_id = ? AND org_id = ?",
        )
        .get(projectId, orgId);
      if (grant) access = minAccess(grant.permission, byRole[role]);
    }
    if (accessRank[access] > accessRank[best]) best = access;
  }
  return best;
}

// A person can sit in several orgs; the one with the most access to the project acts for them.
export function projectMember(
  db: Database,
  userId: string,
  projectId: string,
): { member: MemberRow; access: Access } | null {
  let best: { member: MemberRow; access: Access } | null = null;
  const rows = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE user_id = ?")
    .all(userId);
  for (const { id } of rows) {
    const access = projectAccess(db, { memberId: id }, projectId);
    const member = getMember(db, id);
    if (member && accessRank[access] > accessRank[best?.access ?? "none"])
      best = { member, access };
  }
  return best;
}
