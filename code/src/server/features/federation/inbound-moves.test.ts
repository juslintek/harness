import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTask } from "../board/api";
import { applyBatch, type Change } from "./apply";
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
const COPY_ID = "1.5";
const CH_COPY = "ch-copy";

let tick = 0;
const stamp = (c: Change): Change => ({
  ...c,
  hlc: `${String(Date.now() + 10_000 + ++tick).padStart(13, "0")}-0000-${b.instanceId}`,
});
const del = (c: Change): Change => stamp({ ...c, op: "del", data: null });
const put = (table: string, id: string, project: string, data: object): Change =>
  stamp(peerChange(b, table, id, project, data));

// What the sync loop does with a page from b: judge it, then apply what is left.
function page(...changes: Change[]): number {
  const { allowed } = permitInbound(a.db, b.instanceId, changes);
  applyBatch(a.db, allowed);
  return allowed.length;
}

const count = (sql: string, ...args: string[]): number =>
  a.db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;

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
  // b's own copy project here, homed at b, with the numeric-looking id.
  a.db.run(
    "INSERT INTO projects (id, org_id, key, name, created_at, home_instance) VALUES (?, ?, 'CP', 'Copy', 1, ?)",
    [COPY_ID, stubOrg, b.instanceId],
  );
  a.db.run(
    "INSERT INTO channels (id, org_id, kind, name, project_id, created_at) VALUES (?, ?, 'project', 'Copy', ?, 1)",
    [CH_COPY, stubOrg, COPY_ID],
  );
});

afterAll(() => {
  a.stop();
  b.stop();
});

const messageData = (id: string, channel: string, root: string | null = null): object => ({
  id,
  channel_id: channel,
  thread_root_id: root,
  author_id: BEE,
  body: "x",
  created_at: 1,
  edited_at: null,
});

test("a write peer cannot move its root message into its copy channel to delete it with its replies", () => {
  // Reproduces the attack through the copy-mode hole (a fake incoming channel in the page) on purpose, because that is how it worked.
  a.db.run(
    "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES ('m-r', ?, ?, 'x', 1)",
    [chP, BEE],
  );
  a.db.run(
    "INSERT INTO messages (id, channel_id, thread_root_id, author_id, body, created_at) VALUES ('m-x', ?, 'm-r', ?, 'home reply', 1)",
    [chP, seed.memberId],
  );
  const fakeChannel = put("channels", CH_COPY, seed.projectId, {
    id: CH_COPY,
    org_id: seed.orgId,
    kind: "project",
    name: "fake",
    project_id: seed.projectId,
    created_at: 1,
  });
  page(fakeChannel, put("messages", "m-r", seed.projectId, messageData("m-r", CH_COPY)));
  page(del(put("messages", "m-r", COPY_ID, messageData("m-r", CH_COPY))));
  expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-x'")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-r' AND channel_id = ?", chP)).toBe(
    1,
  );
});

test("a write peer cannot move a home task into its copy project with a numeric project_id", () => {
  const home = createTask(a.db, {
    projectId: seed.projectId,
    title: "h",
    createdBy: seed.memberId,
  });
  const sub = createTask(a.db, {
    projectId: seed.projectId,
    title: "s",
    createdBy: seed.memberId,
    parentId: home.id,
  });
  const moved = put("tasks", home.id, seed.projectId, {
    ...taskRow(home.id, seed.projectId, seed.orgId),
    project_id: 1.5,
    created_by: seed.memberId,
  });
  page(moved);
  page(del(put("tasks", home.id, COPY_ID, taskRow(home.id, COPY_ID, seed.orgId))));
  expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = ?", sub.id)).toBe(1);
  expect(
    count(
      "SELECT COUNT(*) AS n FROM tasks WHERE id = ? AND project_id = ?",
      home.id,
      seed.projectId,
    ),
  ).toBe(1);
});

test("a write peer cannot point a reference column at a non-string either", () => {
  const home = createTask(a.db, {
    projectId: seed.projectId,
    title: "n",
    createdBy: seed.memberId,
  });
  const verdict = (table: string, data: object): number =>
    permitInbound(a.db, b.instanceId, [put(table, "x-new", seed.projectId, data)]).allowed.length;
  expect(verdict("messages", messageData("x-new", 7 as unknown as string))).toBe(0);
  expect(
    verdict("comments", { id: "x-new", task_id: 7, author_id: BEE, body: "x", created_at: 1 }),
  ).toBe(0);
  expect(
    verdict("comments", {
      id: "x-new",
      task_id: home.id,
      author_id: BEE,
      body: "x",
      created_at: 1,
    }),
  ).toBe(1);
});

test("a write peer still edits its own rows in place and adds new ones to a granted project", () => {
  const mine = createTask(a.db, { projectId: seed.projectId, title: "m", createdBy: BEE });
  const verdict = (c: Change): number => permitInbound(a.db, b.instanceId, [c]).allowed.length;
  const own = (id: string, project: string, creator: string): Change =>
    put("tasks", id, project, { ...taskRow(id, project, seed.orgId), created_by: creator });
  expect(verdict(own(mine.id, seed.projectId, BEE))).toBe(1);
  expect(verdict(own("t-fresh", seed.projectId, BEE))).toBe(1);
  expect(verdict(put("messages", "m-bee-ok", seed.projectId, messageData("m-bee-ok", chP)))).toBe(
    1,
  );
  a.db.run(
    "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES ('m-bee-ok', ?, ?, 'x', 1)",
    [chP, BEE],
  );
  expect(verdict(put("messages", "m-bee-ok", seed.projectId, messageData("m-bee-ok", chP)))).toBe(
    1,
  );
  // In its own copy project nothing changes for the peer.
  const copyTask = put("tasks", "t-copy", COPY_ID, {
    ...taskRow("t-copy", COPY_ID, stubOrg),
    created_by: BEE,
  });
  expect(verdict(copyTask)).toBe(1);
});
