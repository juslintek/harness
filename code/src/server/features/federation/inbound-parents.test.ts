import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { applyBatch, type BatchResult, type Change } from "./apply";
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
let chP: string;
let stubOrg: string;

const BEE = "m-bee";
const Q = "proj-q";
const CH_Q = "ch-q";

let tick = 0;
const put = (table: string, id: string, project: string, data: object): Change => ({
  ...peerChange(b, table, id, project, data),
  hlc: `${String(Date.now() + 10_000 + ++tick).padStart(13, "0")}-0000-${b.instanceId}`,
});

function page(...changes: Change[]): BatchResult {
  const { allowed } = permitInbound(a.db, b.instanceId, changes);
  return applyBatch(a.db, allowed);
}

const count = (sql: string, ...args: string[]): number =>
  a.db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

const task = (id: string, project: string, org: string, parent: string | null): Change =>
  put("tasks", id, project, { ...taskRow(id, project, org), created_by: BEE, parent_id: parent });
const reply = (id: string, channel: string, root: string | null): Change =>
  put("messages", id, channel === CH_Q ? Q : seed.projectId, {
    id,
    channel_id: channel,
    thread_root_id: root,
    author_id: BEE,
    body: "x",
    created_at: 1,
    edited_at: null,
  });

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  await shareTo(a, seed, b, "write");
  addPeerMember(a, b, BEE);
  stubOrg =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
      .get(b.instanceId)?.id ?? "";
  chP =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
      .get(seed.projectId)?.id ?? "";
  a.db.run(
    "INSERT INTO projects (id, org_id, key, name, created_at, home_instance) VALUES (?, ?, 'CQ', 'Copy', 1, ?)",
    [Q, stubOrg, b.instanceId],
  );
  a.db.run(
    "INSERT INTO channels (id, org_id, kind, name, project_id, created_at) VALUES (?, ?, 'project', 'Copy', ?, 1)",
    [CH_Q, stubOrg, Q],
  );
});

afterAll(() => {
  a.stop();
  b.stop();
});

const none = (rejected: number): BatchResult => ({ applied: 0, stale: 0, rejected });

test("a write peer's new parent task and new subtask in one page both apply", () => {
  const parent = task("t-new-parent", seed.projectId, seed.orgId, null);
  const child = task("t-new-child", seed.projectId, seed.orgId, "t-new-parent");
  expect(page(parent, child)).toEqual({ applied: 2, stale: 0, rejected: 0 });
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = 't-new-parent'")).toBe(1);
});

test("a write peer's new root message and new reply in one page both apply", () => {
  const root = reply("m-new-root", chP, null);
  const answer = reply("m-new-reply", chP, "m-new-root");
  expect(page(root, answer)).toEqual({ applied: 2, stale: 0, rejected: 0 });
  expect(count("SELECT COUNT(*) AS n FROM messages WHERE thread_root_id = 'm-new-root'")).toBe(1);
});

test("a new task of a write peer is not stored under a parent in its copy project", () => {
  expect(page(task("tq", Q, stubOrg, null)).applied).toBe(1);
  const before = count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?", seed.projectId);
  expect(page(task("t-hung", seed.projectId, seed.orgId, "tq"))).toEqual(none(1));
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-hung'")).toBe(0);
  // deleting the copy project's task would have taken the child, and its home comments, along
  a.db.run("DELETE FROM tasks WHERE id = 'tq'");
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?", seed.projectId)).toBe(
    before,
  );
});

test("a new reply of a write peer is not stored under a root in another channel", () => {
  a.db.run(
    "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES ('m-root-q', ?, ?, 'x', 1)",
    [CH_Q, BEE],
  );
  expect(page(reply("m-hung", chP, "m-root-q"))).toEqual(none(1));
  expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-hung'")).toBe(0);
});

test("a reply under another reply is not stored", () => {
  expect(page(reply("m-sub", chP, "m-new-reply"))).toEqual(none(1));
});

test("a new task under a parent already stored in its project and a reply under a stored root apply", () => {
  const parent = createTask(a.db, { projectId: seed.projectId, title: "p", createdBy: BEE });
  expect(page(task("t-ok", seed.projectId, seed.orgId, parent.id)).applied).toBe(1);
  a.db.run(
    "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES ('m-root-p', ?, ?, 'x', 1)",
    [chP, BEE],
  );
  expect(page(reply("m-ok", chP, "m-root-p")).applied).toBe(1);
});

const drop = (c: Change): Change => ({
  ...c,
  op: "del",
  data: null,
  hlc: `${String(Date.now() + 10_000 + ++tick).padStart(13, "0")}-0000-${b.instanceId}`,
});

test("a task is not moved to its copy project, so deleting it there cannot cascade over its subtasks", () => {
  const x = task("t-mv-x", seed.projectId, seed.orgId, null);
  const child = task("t-mv-c", seed.projectId, seed.orgId, "t-mv-x");
  const moved = task("t-mv-x", Q, stubOrg, null);
  expect(page(x, child, moved)).toEqual({ applied: 2, stale: 0, rejected: 1 });
  expect(
    count("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-mv-x' AND project_id = ?", seed.projectId),
  ).toBe(1);
  a.db.run(
    "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES ('c-mv', 't-mv-c', ?, 'x', 1)",
    [BEE],
  );
  page(drop(moved));
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-mv-c'")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM comments WHERE id = 'c-mv'")).toBe(1);
});

test("a root message is not moved to another channel, so deleting it there cannot cascade over its replies", () => {
  const root = reply("m-mv-root", chP, null);
  const answer = reply("m-mv-reply", chP, "m-mv-root");
  const moved = reply("m-mv-root", CH_Q, null);
  expect(page(root, answer, moved)).toEqual({ applied: 2, stale: 0, rejected: 1 });
  expect(
    count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-mv-root' AND channel_id = ?", chP),
  ).toBe(1);
  page(drop(moved));
  expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-mv-reply'")).toBe(1);
});

test("an update of a stored task in its own project still applies", () => {
  const stored = createTask(a.db, { projectId: seed.projectId, title: "old", createdBy: BEE });
  const edit = put("tasks", stored.id, seed.projectId, {
    ...taskRow(stored.id, seed.projectId, seed.orgId),
    title: "new",
    created_by: BEE,
  });
  expect(page(edit).applied).toBe(1);
  expect(
    a.db.query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id = ?").get(stored.id)
      ?.title,
  ).toBe("new");
});

test("a parent in the copy project and a child in the granted project in one page: the child is rejected", () => {
  const parent = task("t-cp-parent", Q, stubOrg, null);
  const child = task("t-cp-child", seed.projectId, seed.orgId, "t-cp-parent");
  expect(page(parent, child)).toEqual({ applied: 1, stale: 0, rejected: 1 });
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = 't-cp-child'")).toBe(0);
});
