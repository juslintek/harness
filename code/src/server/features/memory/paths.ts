import { posix } from "node:path";
import type { NoteScope } from "../../../shared/memory";

export interface Viewer {
  orgId: string;
  memberId: string | null;
  projectIds: string[];
  canWriteGlobal: boolean;
  // False for a viewer-role member: reads stay open, every write is refused.
  canWrite: boolean;
  actor: string;
}

export interface Located {
  scope: NoteScope;
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
  rel: string;
  disk: string;
}

const REL = /^[a-z0-9._/-]+\.md$/;
const ID = /^[A-Za-z0-9_-]+$/;
const SCOPE_DIRS = ["global", "org", "project", "agent"];

// A segment starting with "." covers "..", ".git" and hidden files in one check.
function validRel(rel: string): boolean {
  if (rel.length > 200 || !REL.test(rel) || rel.startsWith("/")) return false;
  if (posix.normalize(rel) !== rel) return false;
  return rel.split("/").every((s) => s !== "" && !s.startsWith("."));
}

// A folder path follows the note rules minus the .md ending, so nested folders can be viewed.
// Dots stay allowed because note paths allow them in any segment, so a folder like foo.bar exists.
function validDirRel(rel: string): boolean {
  if (rel.length > 200 || !/^[a-z0-9._/-]+$/.test(rel) || posix.normalize(rel) !== rel)
    return false;
  return rel.split("/").every((s) => s !== "" && !s.startsWith("."));
}

export function toDisk(loc: Omit<Located, "disk">): string {
  switch (loc.scope) {
    case "global":
      return `global/${loc.rel}`;
    case "org":
      return `orgs/${loc.orgId}/org/${loc.rel}`;
    case "project":
      return `orgs/${loc.orgId}/projects/${loc.projectId}/${loc.rel}`;
    case "agent":
      return `orgs/${loc.orgId}/agents/${loc.memberId}/${loc.rel}`;
  }
}

function make(
  scope: NoteScope,
  orgId: string | null,
  projectId: string | null,
  memberId: string | null,
  rel: string,
): Located | null {
  if (!validRel(rel)) return null;
  if (![orgId, projectId, memberId].every((v) => v === null || ID.test(v))) return null;
  const base = { scope, orgId, projectId, memberId, rel };
  return { ...base, disk: toDisk(base) };
}

export function diskToLocated(disk: string): Located | null {
  const p = disk.split("/");
  const rest = (n: number): string => p.slice(n).join("/");
  if (p[0] === "global") return make("global", null, null, null, rest(1));
  if (p[0] !== "orgs" || p[1] === undefined) return null;
  const orgId = p[1];
  if (p[2] === "org") return make("org", orgId, null, null, rest(3));
  if (p[2] === "projects" && p[3] !== undefined) return make("project", orgId, p[3], null, rest(4));
  if (p[2] === "agents" && p[3] !== undefined) return make("agent", orgId, null, p[3], rest(4));
  return null;
}

function resolveScoped(
  p: string[],
  viewer: Viewer,
  projectBySlug: (slug: string) => string | null,
): Located | "dir" | null {
  const scope = p[2] as string;
  const rel = (n: number): string => p.slice(n).join("/");
  const note = (
    start: number,
    project: string | null,
    member: string | null,
    org: string | null,
  ): Located | "dir" | null =>
    make(scope as NoteScope, org, project, member, rel(start)) ??
    (validDirRel(rel(start)) ? "dir" : null);
  if (scope === "global") return note(3, null, null, null);
  if (scope === "org") return note(3, null, null, viewer.orgId);
  if (scope === "agent")
    return viewer.memberId === null ? null : note(3, null, viewer.memberId, viewer.orgId);
  const projectId = projectBySlug(p[3] as string);
  if (projectId === null || !viewer.projectIds.includes(projectId)) return null;
  return p.length === 4 ? "dir" : note(4, projectId, null, viewer.orgId);
}

export function resolveVirtual(
  vpath: string,
  viewer: Viewer,
  projectBySlug: (slug: string) => string | null,
): Located | "dir" | null {
  if (posix.normalize(vpath) !== vpath || vpath.includes("\\") || vpath.includes("\0")) return null;
  const p = vpath.split("/");
  if (p[0] !== "" || p[1] !== "memories") return null;
  if (p.length === 2) return "dir";
  const scope = p[2] as string;
  if (!SCOPE_DIRS.includes(scope)) return null;
  if (p.length === 3) return scope === "agent" && viewer.memberId === null ? null : "dir";
  return resolveScoped(p, viewer, projectBySlug);
}

export function toVirtual(loc: Located, projectSlug: (id: string) => string): string {
  switch (loc.scope) {
    case "global":
      return `/memories/global/${loc.rel}`;
    case "org":
      return `/memories/org/${loc.rel}`;
    case "project":
      return `/memories/project/${projectSlug(loc.projectId as string)}/${loc.rel}`;
    case "agent":
      return `/memories/agent/${loc.rel}`;
  }
}

function sameOrg(viewer: Viewer, loc: Located): boolean {
  return loc.orgId === viewer.orgId;
}

export function canRead(viewer: Viewer, loc: Located): boolean {
  switch (loc.scope) {
    case "global":
      return true;
    case "org":
      return sameOrg(viewer, loc);
    case "project":
      return sameOrg(viewer, loc) && viewer.projectIds.includes(loc.projectId as string);
    case "agent":
      return sameOrg(viewer, loc) && (viewer.memberId === null || viewer.memberId === loc.memberId);
  }
}

export function canWrite(viewer: Viewer, loc: Located): boolean {
  if (!viewer.canWrite) return false;
  if (loc.scope === "global") return viewer.canWriteGlobal;
  return canRead(viewer, loc);
}
