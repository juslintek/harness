import type { Database } from "bun:sqlite";
import type { OrgView } from "../../../shared/orgs";
import {
  createPosition,
  directReportsOf,
  listPositions,
  managerPositionsOf,
  reportsTransitivelyTo,
  updatePosition,
} from "./positions";
import {
  createProject,
  getProject,
  grantProject,
  listGrantOrgIds,
  listProjects,
  onGrantChanged,
  revokeGrant,
} from "./projects";
import {
  addAgentMember,
  addHumanMember,
  addToTeam,
  createOrg,
  createTeam,
  findMemberByHandle,
  findMembersByHandle,
  getMember,
  getOrg,
  getOrgBySlug,
  listMembers,
  listOrgsForUser,
  listTeams,
  memberForUser,
  onMemberDemoted,
  onMemberRemoved,
  onOrgCreated,
  personOf,
  removeFromTeam,
  removeMember,
  updateMember,
} from "./repo";
import { orgAccess, projectAccess, projectMember, roleAtLeast } from "./roles";

export type { Role } from "../../../shared/orgs";
export type { PositionPatch, PositionRow } from "./positions";
export type { GrantRow, ProjectRow } from "./projects";
export type { MemberPatch, MemberRow, TeamRow } from "./repo";
export type { Access } from "./roles";

export {
  addAgentMember,
  addHumanMember,
  addToTeam,
  createOrg,
  createPosition,
  createProject,
  createTeam,
  directReportsOf,
  findMemberByHandle,
  findMembersByHandle,
  getMember,
  getOrg,
  getOrgBySlug,
  getProject,
  grantProject,
  listGrantOrgIds,
  listMembers,
  listOrgsForUser,
  listPositions,
  listProjects,
  listTeams,
  managerPositionsOf,
  memberForUser,
  onGrantChanged,
  onMemberDemoted,
  onMemberRemoved,
  onOrgCreated,
  orgAccess,
  personOf,
  projectAccess,
  projectMember,
  removeFromTeam,
  removeMember,
  reportsTransitivelyTo,
  revokeGrant,
  roleAtLeast,
  updateMember,
  updatePosition,
};

export function handleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  const handle = local.slice(0, 32);
  return handle.length >= 2 ? handle : "user";
}

export function ensurePersonalOrg(
  db: Database,
  user: { id: string; name: string; email: string },
): OrgView {
  const existing = listOrgsForUser(db, user.id).find(
    (o) => o.name === "Personal" && memberForUser(db, o.id, user.id)?.role === "owner",
  );
  if (existing) return existing;
  const taken = db.query("SELECT 1 FROM orgs WHERE slug = 'personal'").get();
  const slug = taken ? `personal-${user.id.slice(-8).toLowerCase()}` : "personal";
  return createOrg(db, {
    name: "Personal",
    slug,
    ownerUserId: user.id,
    ownerName: user.name,
    ownerHandle: handleFromEmail(user.email),
  });
}
