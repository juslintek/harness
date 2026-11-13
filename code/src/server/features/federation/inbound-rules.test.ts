import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import type { Change } from "./apply";
import { permitInbound } from "./inbound";
import {
  addPeerMember,
  bootNode,
  type Node,
  pairNodes,
  peerChange,
  type Seed,
  seedProject,
  shareTo,
  taskRow,
} from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;

const change = (
  table: string,
  rowId: string,
  project: string,
  data: object,
  origin?: string,
): Change => peerChange(b, table, rowId, project, data, origin);
const taskData = taskRow;

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  await shareTo(a, seed, b, "write");
});

afterAll(() => {
  a.stop();
  b.stop();
});

const verdict = (c: Change): number => permitInbound(a.db, b.instanceId, [c]).allowed.length;

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
  addPeerMember(a, b, "m-grab");
  const sent = (id: string, extra: object): Record<string, unknown> => {
    // A stored task keeps its creator; a new one must name the peer's own member.
    const base = {
      ...taskData(id, seed.projectId, seed.orgId),
      created_by: id === held ? seed.memberId : "m-grab",
    };
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

test("comments and messages from a write peer must be authored by a member of its own stub org", () => {
  const stub = a.db
    .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
    .get(b.instanceId)?.id;
  a.db.run(
    `INSERT INTO members (id, org_id, kind, user_id, handle, display_name, role, created_at)
     VALUES ('m-bee', ?, 'human', 'remote:m-bee', 'bee3', 'Bee', 'member', 1)`,
    [stub ?? null],
  );
  const taskId = createTask(a.db, {
    projectId: seed.projectId,
    title: "talk",
    createdBy: seed.memberId,
  }).id;
  const channelId = a.db
    .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
    .get(seed.projectId)?.id;
  const comment = (author: string): Change =>
    change("comments", `c-${author}`, seed.projectId, {
      id: `c-${author}`,
      task_id: taskId,
      author_id: author,
      body: "hi",
      created_at: 1,
    });
  const message = (author: string): Change =>
    change("messages", `x-${author}`, seed.projectId, {
      id: `x-${author}`,
      channel_id: channelId,
      thread_root_id: null,
      author_id: author,
      body: "hi",
      created_at: 1,
      edited_at: null,
    });
  expect(verdict(comment(seed.memberId))).toBe(0);
  expect(verdict(message(seed.memberId))).toBe(0);
  expect(verdict(comment("m-bee"))).toBe(1);
  expect(verdict(message("m-bee"))).toBe(1);
});
