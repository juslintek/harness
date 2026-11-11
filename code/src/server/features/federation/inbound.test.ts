import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { createProject } from "../orgs/api";
import type { Change } from "./apply";
import { permitInbound } from "./inbound";
import { bootNode, type Node, pairNodes, type Seed, seedProject, shareTo } from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;
let privateTask: string;
let privateProject: string;
const HLC = (n: Node): string => `${String(Date.now()).padStart(13, "0")}-0000-${n.instanceId}`;

function change(
  table: string,
  rowId: string,
  project: string,
  data: object,
  origin = b.instanceId,
): Change {
  return {
    project_id: project,
    table_name: table,
    row_id: rowId,
    op: "put",
    hlc: HLC(b),
    origin_instance: origin,
    data: JSON.stringify(data),
  };
}

const taskData = (id: string, project: string, org: string): object => ({
  id,
  org_id: org,
  project_id: project,
  number: 9,
  parent_id: null,
  title: "forged",
  description: "",
  status: "todo",
  rank: 1,
  assignee_id: null,
  holder_id: null,
  checked_out_at: null,
  estimate_minutes: null,
  created_by: "x",
  created_at: 1,
  updated_at: 1,
});

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  privateProject = createProject(a.db, { orgId: seed.orgId, key: "PRV", name: "Private" }).id;
  privateTask = createTask(a.db, {
    projectId: privateProject,
    title: "p",
    createdBy: seed.memberId,
  }).id;
  await shareTo(a, seed, b, "write");
});

afterAll(() => {
  a.stop();
  b.stop();
});

const verdict = (c: Change): number => permitInbound(a.db, b.instanceId, [c]).allowed.length;

test("a well-formed task for a project granted write is allowed", () => {
  expect(
    verdict(
      change("tasks", "t-new", seed.projectId, taskData("t-new", seed.projectId, seed.orgId)),
    ),
  ).toBe(1);
});

test("a task row cannot be moved into, or taken from, a project the peer has no grant on", () => {
  const label = seed.projectId;
  expect(
    verdict(change("tasks", privateTask, label, taskData(privateTask, privateProject, seed.orgId))),
  ).toBe(0);
  expect(
    verdict(change("tasks", privateTask, label, taskData(privateTask, label, seed.orgId))),
  ).toBe(0);
  expect(verdict(change("tasks", "t2", label, taskData("t2", privateProject, seed.orgId)))).toBe(0);
  expect(
    verdict(change("tasks", "t3", privateProject, taskData("t3", privateProject, seed.orgId))),
  ).toBe(0);
});

test("a task naming another org than its project is refused", () => {
  const other = taskData("t4", seed.projectId, "someone-else");
  expect(verdict(change("tasks", "t4", seed.projectId, other))).toBe(0);
});

test("changes under another origin, and home-owned tables, are refused", () => {
  const data = taskData("t5", seed.projectId, seed.orgId);
  expect(verdict(change("tasks", "t5", seed.projectId, data, a.instanceId))).toBe(0);
  const project = {
    id: seed.projectId,
    org_id: seed.orgId,
    key: "X",
    name: "x",
    home_instance: b.instanceId,
    created_at: 1,
  };
  expect(verdict(change("projects", seed.projectId, seed.projectId, project))).toBe(0);
  const grant = {
    id: "g",
    project_id: seed.projectId,
    org_id: seed.orgId,
    permission: "write",
    created_at: 1,
  };
  expect(verdict(change("grants", "g", seed.projectId, grant))).toBe(0);
  const org = { id: seed.orgId, slug: "acme", name: "hijack", home_instance: b.instanceId };
  expect(verdict(change("orgs", seed.orgId, seed.projectId, org))).toBe(0);
});

test("a peer cannot rewrite a member of a local org, only those of its own stub org", () => {
  const member = (org: string): object => ({
    id: seed.memberId,
    org_id: org,
    kind: "human",
    handle: "ann",
    display_name: "x",
    role: "owner",
  });
  expect(verdict(change("members", seed.memberId, seed.projectId, member(seed.orgId)))).toBe(0);
  const stub = a.db
    .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
    .get(b.instanceId);
  const fresh = {
    id: "m-b",
    org_id: stub?.id,
    kind: "human",
    handle: "bee",
    display_name: "Bee",
    role: "admin",
  };
  expect(verdict(change("members", "m-b", seed.projectId, fresh))).toBe(1);
  expect(
    verdict(change("members", seed.memberId, seed.projectId, { ...fresh, id: seed.memberId })),
  ).toBe(0);
});

test("a home cannot touch local projects or orgs of the instance that pulls from it", () => {
  const local = seedProject(b, "bee");
  const from = (c: Change): number =>
    permitInbound(b.db, a.instanceId, [{ ...c, origin_instance: a.instanceId }]).allowed.length;
  const task = taskData("t6", local.projectId, local.orgId);
  expect(from(change("tasks", "t6", local.projectId, task))).toBe(0);
  const claim = {
    id: "p-new",
    org_id: local.orgId,
    key: "N",
    name: "n",
    home_instance: a.instanceId,
    created_at: 1,
  };
  expect(from(change("projects", "p-new", "p-new", claim))).toBe(0);
  const ok = { ...claim, org_id: seed.orgId };
  expect(from(change("projects", "p-new", "p-new", ok))).toBe(1);
  const grant = {
    id: "g9",
    project_id: "p-new",
    org_id: local.orgId,
    permission: "write",
    created_at: 1,
  };
  const both = permitInbound(
    b.db,
    a.instanceId,
    [change("projects", "p-new", "p-new", ok), change("grants", "g9", "p-new", grant)].map((c) => ({
      ...c,
      origin_instance: a.instanceId,
    })),
  );
  expect(both.allowed.map((c) => c.table_name)).toEqual(["projects"]);
});

// b holds a local project with a stub org granted on it, and an org last written by another peer.
function seedOrgs(): void {
  const local = seedProject(b, "bee2");
  b.db.run(
    "INSERT INTO orgs (id, slug, name, created_at, home_instance, origin_instance) VALUES ('o-stub', 'peer-x', 'X', 1, 'inst-y', ?)",
    [a.instanceId],
  );
  b.db.run(
    "INSERT INTO grants (id, project_id, org_id, permission, granted_by, created_at) VALUES ('g-stub', ?, 'o-stub', 'write', 'u', 1)",
    [local.projectId],
  );
  b.db.run(
    "INSERT INTO orgs (id, slug, name, created_at, home_instance, origin_instance) VALUES ('o-z', 'z', 'Z', 1, 'inst-z', 'inst-z')",
  );
}

test("a home cannot flip, delete or reuse orgs that it does not own", () => {
  seedOrgs();
  const org = (id: string, home: string | null, slug = id): object => ({
    id,
    slug,
    name: id,
    home_instance: home,
  });
  const project = change("projects", "p-n2", "p-n2", {
    id: "p-n2",
    org_id: seed.orgId,
    key: "N2",
    name: "n2",
    home_instance: a.instanceId,
    created_at: 1,
  });
  const allowed = (...cs: Change[]): string[] =>
    permitInbound(
      b.db,
      a.instanceId,
      [project, ...cs].map((c) => ({ ...c, origin_instance: a.instanceId })),
    ).allowed.map((c) => `${c.table_name}:${c.row_id}`);
  const put = (id: string, home: string | null): Change =>
    change("orgs", id, "p-n2", org(id, home));
  const member = (id: string, orgId: string): Change =>
    change("members", id, "p-n2", {
      id,
      org_id: orgId,
      kind: "human",
      handle: id,
      display_name: id,
      role: "member",
    });

  expect(allowed(put("o-stub", a.instanceId))).toEqual(["projects:p-n2"]);
  expect(allowed(put("o-stub", "inst-y"))).toEqual(["projects:p-n2"]);
  expect(allowed({ ...put("o-stub", "inst-y"), op: "del", data: null })).toEqual(["projects:p-n2"]);
  expect(allowed(put("o-z", "inst-z"))).toEqual(["projects:p-n2"]);
  expect(allowed(put("o-new", null))).toEqual(["projects:p-n2"]);
  expect(allowed(put("o-new", a.instanceId))).toEqual(["projects:p-n2", "orgs:o-new"]);
  expect(allowed(member("m1", "o-z"))).toEqual(["projects:p-n2"]);
  expect(allowed(member("m2", "o-stub"))).toEqual(["projects:p-n2"]);
  expect(allowed(put("o-new", a.instanceId), member("m3", "o-new"))).toEqual([
    "projects:p-n2",
    "orgs:o-new",
    "members:m3",
  ]);
});

test("a peer with write access cannot set or clear a task's holder or checkout time", () => {
  const held = createTask(a.db, {
    projectId: seed.projectId,
    title: "held",
    createdBy: seed.memberId,
  }).id;
  a.db.run("UPDATE tasks SET holder_id = ?, checked_out_at = 5 WHERE id = ?", [
    seed.memberId,
    held,
  ]);
  const sent = (id: string, extra: object): Record<string, unknown> => {
    const base = taskData(id, seed.projectId, seed.orgId);
    const out = permitInbound(a.db, b.instanceId, [
      change("tasks", id, seed.projectId, { ...base, ...extra }),
    ]).allowed;
    return JSON.parse(out[0]?.data ?? "{}");
  };
  expect(sent(held, { holder_id: null, checked_out_at: null })).toMatchObject({
    holder_id: seed.memberId,
    checked_out_at: 5,
  });
  expect(sent("t-grab", { holder_id: seed.memberId, checked_out_at: 9 })).toMatchObject({
    holder_id: null,
    checked_out_at: null,
  });
});
