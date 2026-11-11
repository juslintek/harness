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
let taskId: string;
let channelId: string;

const BEE = "m-bee";

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  await shareTo(a, seed, b, "write");
  addPeerMember(a, b, BEE);
  taskId = createTask(a.db, {
    projectId: seed.projectId,
    title: "talk",
    createdBy: seed.memberId,
  }).id;
  channelId =
    a.db
      .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
      .get(seed.projectId)?.id ?? "";
  for (const [id, author] of [
    ["c-home", seed.memberId],
    ["c-bee", BEE],
  ] as const) {
    a.db.run(
      "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', 1)",
      [id, taskId, author],
    );
    a.db.run(
      "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', 1)",
      [id.replace("c-", "m-"), channelId, author],
    );
  }
});

afterAll(() => {
  a.stop();
  b.stop();
});

const verdict = (c: Change): number => permitInbound(a.db, b.instanceId, [c]).allowed.length;
const del = (c: Change): Change => ({ ...c, op: "del", data: null });

const comment = (id: string, author: string): Change =>
  peerChange(b, "comments", id, seed.projectId, {
    id,
    task_id: taskId,
    author_id: author,
    body: "mine now",
    created_at: 1,
  });
const message = (id: string, author: string): Change =>
  peerChange(b, "messages", id, seed.projectId, {
    id,
    channel_id: channelId,
    thread_root_id: null,
    author_id: author,
    body: "mine now",
    created_at: 1,
    edited_at: null,
  });

test("a write peer cannot overwrite or delete a comment or message a home user wrote", () => {
  // A message of its own with no thread root is a root, which a peer can no longer delete.
  for (const [make, home, own, ownDeletable] of [
    [comment, "c-home", "c-bee", 1],
    [message, "m-home", "m-bee", 0],
  ] as const) {
    expect(verdict(make(home, BEE))).toBe(0);
    expect(verdict(del(make(home, BEE)))).toBe(0);
    expect(verdict(make(own, BEE))).toBe(1);
    expect(verdict(del(make(own, BEE)))).toBe(ownDeletable);
  }
});

test("a write peer cannot credit a task to a home member, new or stored", () => {
  const task = (id: string, createdBy: string): Change =>
    peerChange(b, "tasks", id, seed.projectId, {
      ...taskRow(id, seed.projectId, seed.orgId),
      created_by: createdBy,
    });
  expect(verdict(task("t-new-home", seed.memberId))).toBe(0);
  expect(verdict(task("t-new-bee", BEE))).toBe(1);
  // Editing a home task is allowed while its creator stays as stored.
  expect(verdict(task(taskId, seed.memberId))).toBe(1);
  expect(verdict(task(taskId, "m-someone-else"))).toBe(0);
});

test("a write peer cannot re-credit a stored home task to its own member", () => {
  const recredit = peerChange(b, "tasks", taskId, seed.projectId, {
    ...taskRow(taskId, seed.projectId, seed.orgId),
    created_by: BEE,
  });
  expect(verdict(recredit)).toBe(0);
});

test("a write peer cannot delete a task at all, since the delete cascades", () => {
  const mine = createTask(a.db, { projectId: seed.projectId, title: "mine", createdBy: BEE }).id;
  const gone = (id: string): Change =>
    del(peerChange(b, "tasks", id, seed.projectId, taskRow(id, seed.projectId, seed.orgId)));
  expect(verdict(gone(taskId))).toBe(0);
  expect(verdict(gone(mine))).toBe(0);
});

test("a write peer cannot re-parent a stored home task under its own task", () => {
  const mine = createTask(a.db, { projectId: seed.projectId, title: "p", createdBy: BEE }).id;
  const reparent = (id: string, parent: string | null, createdBy: string): Change =>
    peerChange(b, "tasks", id, seed.projectId, {
      ...taskRow(id, seed.projectId, seed.orgId),
      parent_id: parent,
      created_by: createdBy,
    });
  expect(verdict(reparent(taskId, mine, seed.memberId))).toBe(0);
  expect(verdict(reparent(taskId, null, seed.memberId))).toBe(1);
  expect(verdict(reparent(mine, taskId, BEE))).toBe(0);
});

test("a write peer cannot delete a root message, or re-root one to get it cascaded", () => {
  const root = (id: string): Change => del(message(id, BEE));
  for (const [id, replyAuthor] of [
    ["m-root-home", seed.memberId],
    ["m-root-bee", BEE],
  ] as const) {
    a.db.run(
      "INSERT INTO messages (id, channel_id, author_id, body, created_at) VALUES (?, ?, ?, 'x', 1)",
      [id, channelId, BEE],
    );
    a.db.run(
      "INSERT INTO messages (id, channel_id, thread_root_id, author_id, body, created_at) VALUES (?, ?, ?, ?, 'r', 1)",
      [`${id}-reply`, channelId, id, replyAuthor],
    );
  }
  expect(verdict(root("m-root-home"))).toBe(0);
  expect(verdict(root("m-root-bee"))).toBe(0);
  const reroot = (id: string, under: string | null): Change => ({
    ...message(id, BEE),
    data: JSON.stringify({ ...JSON.parse(message(id, BEE).data ?? "{}"), thread_root_id: under }),
  });
  expect(verdict(reroot("m-root-home", "m-bee"))).toBe(0);
  expect(verdict(reroot("m-root-home", null))).toBe(1);
  // A reply keeps its root, and a peer's reply may still be deleted.
  expect(verdict(reroot("m-root-bee-reply", "m-root-home"))).toBe(0);
  expect(verdict(del(message("m-root-bee-reply", BEE)))).toBe(1);
});
