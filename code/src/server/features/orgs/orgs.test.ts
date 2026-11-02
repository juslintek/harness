import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import {
  type Access,
  addAgentMember,
  addHumanMember,
  addToTeam,
  createOrg,
  createProject,
  createTeam,
  ensurePersonalOrg,
  findMemberByHandle,
  type GrantRow,
  getMember,
  getOrgBySlug,
  getProject,
  grantProject,
  listMembers,
  listOrgsForUser,
  listProjects,
  listTeams,
  type MemberPatch,
  type MemberRow,
  memberForUser,
  onMemberRemoved,
  onOrgCreated,
  orgAccess,
  type ProjectRow,
  projectAccess,
  type Role,
  removeFromTeam,
  removeMember,
  revokeGrant,
  roleAtLeast,
  type TeamRow,
  updateMember,
} from "./api";

function freshDb(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return db;
}
const org = (db: ReturnType<typeof openDb>, slug: string, user = "u1") =>
  createOrg(db, { name: slug, slug, ownerUserId: user, ownerName: "Owner", ownerHandle: "owner" });

test("createOrg makes owner member, team Core and fires onOrgCreated", () => {
  const db = freshDb();
  const seen: string[] = [];
  const off = onOrgCreated((_db, o, owner) => seen.push(`${o.slug}:${owner.role}`));
  const o = org(db, "acme");
  off();
  expect(seen).toEqual(["acme:owner"]);
  expect(listMembers(db, o.id).map((m) => m.role)).toEqual(["owner"]);
  expect(listTeams(db, o.id).map((t) => t.name)).toEqual(["Core"]);
  expect(listOrgsForUser(db, "u1").map((x) => x.slug)).toEqual(["acme"]);
});

test("duplicate handle in org throws, same handle in two orgs ok", () => {
  const db = freshDb();
  const a = org(db, "aa");
  org(db, "bb", "u2");
  expect(() => addHumanMember(db, a.id, "u3", "owner", "Dup", "member")).toThrow();
  expect(() => addHumanMember(db, a.id, "u3", "Bad Handle", "X", "member")).toThrow();
});

test("agent member with role admin rejected", () => {
  const db = freshDb();
  const o = org(db, "acme");
  const agent = addAgentMember(db, o.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "Bot",
    specialties: ["ts"],
  });
  expect(agent.role).toBe("member");
  expect(agent.specialties).toEqual(["ts"]);
  expect(() => updateMember(db, agent.id, { role: "admin" })).toThrow();
  expect(updateMember(db, agent.id, { paused: true }).paused).toBe(true);
});

test("removeMember fires onMemberRemoved with the removed row", () => {
  const db = freshDb();
  const o = org(db, "acme");
  const m = addHumanMember(db, o.id, "u2", "bob", "Bob", "member");
  const seen: string[] = [];
  const off = onMemberRemoved((_db, r) => seen.push(r.handle));
  removeMember(db, m.id);
  off();
  expect(seen).toEqual(["bob"]);
  expect(listMembers(db, o.id)).toHaveLength(1);
});

test("projectAccess: own viewer read, own member write, grantee read grant caps admin, write grant + viewer is read, stranger none", () => {
  const db = freshDb();
  const home = org(db, "home");
  const guest = org(db, "guest", "u9");
  addHumanMember(db, home.id, "viewer", "vw", "V", "viewer");
  addHumanMember(db, home.id, "member", "mb", "M", "member");
  addHumanMember(db, guest.id, "gviewer", "gv", "GV", "viewer");
  const p = createProject(db, { orgId: home.id, key: "app", name: "App" });
  expect(projectAccess(db, "viewer", p.id)).toBe("read");
  expect(projectAccess(db, "member", p.id)).toBe("write");
  expect(projectAccess(db, "u1", p.id)).toBe("admin");
  expect(projectAccess(db, "u9", p.id)).toBe("none");
  grantProject(db, p.id, guest.id, "read", "u1");
  expect(projectAccess(db, "u9", p.id)).toBe("read");
  grantProject(db, p.id, guest.id, "write", "u1");
  expect(projectAccess(db, "u9", p.id)).toBe("write");
  expect(projectAccess(db, "gviewer", p.id)).toBe("read");
  expect(projectAccess(db, "stranger", p.id)).toBe("none");
  const bot = addAgentMember(db, home.id, {
    agentId: "claude",
    handle: "bot",
    displayName: "Bot",
    specialties: [],
  });
  expect(projectAccess(db, { memberId: bot.id }, p.id)).toBe("write");
});

test("createProject with a non-repo path throws, a git repo works", () => {
  const db = freshDb();
  const o = org(db, "acme");
  const dir = mkdtempSync(join(tmpdir(), "orgs-"));
  expect(() => createProject(db, { orgId: o.id, key: "x1", name: "X", repo: dir })).toThrow();
  expect(() =>
    createProject(db, { orgId: o.id, key: "x1", name: "X", repo: "rel/path" }),
  ).toThrow();
  Bun.spawnSync(["git", "init", "-q", dir]);
  expect(createProject(db, { orgId: o.id, key: "x1", name: "X", repo: dir }).repo).toBe(dir);
});

test("ensurePersonalOrg is idempotent and avoids slug clashes", () => {
  const db = freshDb();
  const a = ensurePersonalOrg(db, { id: "u1", name: "Ann", email: "Ann.Lee+x@example.com" });
  expect(ensurePersonalOrg(db, { id: "u1", name: "Ann", email: "Ann.Lee+x@example.com" }).id).toBe(
    a.id,
  );
  expect(listMembers(db, a.id)[0]?.handle).toBe("ann-lee-x");
  const b = ensurePersonalOrg(db, { id: "u2", name: "Bo", email: "bo@example.com" });
  expect(b.slug).not.toBe("personal");
  expect(listOrgsForUser(db, "u1")).toHaveLength(1);
});

test("roleAtLeast orders roles", () => {
  expect(roleAtLeast("admin", "member")).toBe(true);
  expect(roleAtLeast("viewer", "member")).toBe(false);
});

test("lookups, teams and grants round trip", () => {
  const db = freshDb();
  const home = org(db, "home");
  const guest = org(db, "guest", "u9");
  const m: MemberRow | null = findMemberByHandle(db, home.id, "owner");
  expect(m?.userId).toBe("u1");
  expect(getMember(db, m?.id ?? "")?.handle).toBe("owner");
  expect(memberForUser(db, home.id, "u1")?.id).toBe(m?.id);
  expect(getOrgBySlug(db, "home")?.id).toBe(home.id);
  const role: Role | null = orgAccess(db, "u1", home.id);
  expect(role).toBe("owner");
  expect(orgAccess(db, "u1", guest.id)).toBeNull();
  const team: TeamRow = createTeam(db, home.id, "Ops");
  addToTeam(db, team.id, m?.id ?? "");
  removeFromTeam(db, team.id, m?.id ?? "");
  const patch: MemberPatch = { displayName: "Renamed" };
  expect(updateMember(db, m?.id ?? "", patch).displayName).toBe("Renamed");
  const p: ProjectRow = createProject(db, {
    orgId: home.id,
    teamId: team.id,
    key: "app",
    name: "App",
  });
  expect(getProject(db, p.id)?.teamId).toBe(team.id);
  grantProject(db, p.id, guest.id, "read", "u1");
  const access: Access = projectAccess(db, "u9", p.id);
  expect(access).toBe("read");
  expect(listProjects(db, guest.id).map((x) => x.id)).toEqual([p.id]);
  revokeGrant(db, p.id, guest.id);
  expect(listProjects(db, guest.id)).toEqual([]);
  const g: GrantRow["permission"] = "read";
  expect(g).toBe("read");
});
