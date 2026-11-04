import type { Database } from "bun:sqlite";
import type { NoteSummary } from "../../../shared/memory";
import { getMember, listProjects, memberForUser, projectAccess, roleAtLeast } from "../orgs/api";
import { diskToLocated, resolveVirtual, toVirtual, type Viewer } from "./paths";

// Rebuilt from the member row on every call: org and project reach follow the current database
// state, so a removed member or a revoked project loses access at once.
export function agentViewer(db: Database, memberId: string): Viewer {
  const member = getMember(db, memberId);
  if (member?.kind !== "agent") throw new Error("not an agent member");
  const projectIds = listProjects(db, member.orgId)
    .filter((p) => p.orgId === member.orgId && projectAccess(db, { memberId }, p.id) !== "none")
    .map((p) => p.id);
  return {
    orgId: member.orgId,
    memberId,
    projectIds,
    canWriteGlobal: false,
    canWrite: roleAtLeast(member.role, "member"),
    actor: member.handle,
  };
}

// A human sees every agent note of the org (memberId null); only an instance admin writes global notes.
export function humanViewer(
  db: Database,
  orgId: string,
  userId: string,
  isInstanceAdmin: boolean,
): Viewer {
  const member = memberForUser(db, orgId, userId);
  if (member === null) throw new Error("not a member of this org");
  const projectIds = listProjects(db, orgId)
    .filter((p) => p.orgId === orgId && projectAccess(db, userId, p.id) !== "none")
    .map((p) => p.id);
  return {
    orgId,
    memberId: null,
    projectIds,
    canWriteGlobal: isInstanceAdmin,
    canWrite: roleAtLeast(member.role, "member"),
    actor: member.handle,
  };
}

export interface ProjectSlugs {
  idOf: (slug: string) => string | null;
  slugOf: (id: string) => string;
}

export function projectSlugs(db: Database, orgId: string): ProjectSlugs {
  const own = listProjects(db, orgId).filter((p) => p.orgId === orgId);
  return {
    idOf: (slug) => own.find((p) => p.key === slug)?.id ?? null,
    slugOf: (id) => own.find((p) => p.id === id)?.key ?? id,
  };
}

export function resolveNotePath(
  vpath: string,
  viewer: Viewer,
  slugs: ProjectSlugs,
): ReturnType<typeof resolveVirtual> {
  return resolveVirtual(vpath, viewer, slugs.idOf);
}

export function virtualPathOf(note: NoteSummary, slugs: ProjectSlugs): string {
  const loc = diskToLocated(note.path);
  return loc === null ? note.path : toVirtual(loc, slugs.slugOf);
}

export function runProject(db: Database, runId: string): string | null {
  const row = db
    .query<{ project_id: string | null }, [string]>("SELECT project_id FROM runs WHERE id = ?")
    .get(runId);
  return row?.project_id ?? null;
}
