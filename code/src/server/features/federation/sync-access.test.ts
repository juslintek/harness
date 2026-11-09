import { afterAll, beforeAll, expect, test } from "bun:test";
import { sessionHeaders } from "../../test-support/app-kit";
import { createTask, updateTask } from "../board/api";
import { addHumanMember, createProject } from "../orgs/api";
import { flushPending } from "./bodies";
import { changesFor } from "./feed";
import {
  api,
  bootNode,
  type Node,
  pairNodes,
  pull,
  rowsOf,
  type Seed,
  seedProject,
  shareTo,
} from "./sync-kit";

let a: Node;
let b: Node;
let c: Node;
let seed: Seed;
let taskId: string;
let readProject: string;
let readTask: string;

const titleOf = (node: Node, id: string): unknown =>
  rowsOf(node.db, "tasks").find((t) => t.id === id)?.title;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  [a, b, c] = await Promise.all([bootNode(), bootNode(), bootNode()]);
  await pairNodes(a, b);
  await pairNodes(a, c);
  seed = seedProject(a);
  taskId = createTask(a.db, { projectId: seed.projectId, title: "t", createdBy: seed.memberId }).id;
  const second = createProject(a.db, { orgId: seed.orgId, key: "RO", name: "Read only" });
  readProject = second.id;
  readTask = createTask(a.db, { projectId: second.id, title: "ro", createdBy: seed.memberId }).id;
  await shareTo(a, seed, b, "write");
  await shareTo(a, { ...seed, projectId: readProject }, b, "read");
  await pull(b, a);
});

afterAll(() => {
  for (const node of [a, b, c]) node.stop();
});

test("when both sides edit the same title the later edit wins on both after two pulls", async () => {
  updateTask(a.db, taskId, { title: "from A" }, seed.memberId);
  flushPending(a.db, a.home);
  await sleep(5);
  updateTask(b.db, taskId, { title: "from B" }, seed.memberId);
  flushPending(b.db, b.home);
  await pull(a, b);
  await pull(b, a);
  expect(titleOf(a, taskId)).toBe("from B");
  expect(titleOf(b, taskId)).toBe("from B");
});

test("edits to a project granted read-only are dropped by the home", async () => {
  updateTask(b.db, readTask, { title: "sneaky" }, seed.memberId);
  const stats = await pull(a, b);
  expect(stats.applied).toBe(0);
  expect(stats.rejected).toBeGreaterThan(0);
  expect(titleOf(a, readTask)).toBe("ro");
});

test("a third instance gets nothing of a project shared to someone else", async () => {
  const stats = await pull(c, a);
  expect(stats).toEqual({ applied: 0, stale: 0, rejected: 0 });
  expect(rowsOf(c.db, "projects")).toEqual([]);
  expect(rowsOf(c.db, "tasks")).toEqual([]);
  expect(changesFor(a.db, c.instanceId, 0, 500).changes).toEqual([]);
});

test("a copy is never served on to another peer", async () => {
  expect(changesFor(b.db, c.instanceId, 0, 500).changes).toEqual([]);
  expect(changesFor(b.db, a.instanceId, 0, 500).changes.length).toBeGreaterThan(0);
});

test("only an admin of the owning org may share, and revoking stops the feed", async () => {
  const body = { projectId: seed.projectId, peerId: c.instanceId, permission: "read" };
  const session = (stepUp: boolean) => sessionHeaders(a.db, { stepUp, origin: a.origin });
  const stranger = await session(true);
  const plain = await session(true);
  addHumanMember(a.db, seed.orgId, plain.userId, "bob", "Bob", "member");
  const admin = await session(false);
  addHumanMember(a.db, seed.orgId, admin.userId, "cy", "Cy", "admin");
  const post = (h: Record<string, string>) => api(a, "POST", "/api/federation/shares", body, h);
  expect((await post(stranger.headers)).status).toBe(404);
  expect((await post(plain.headers)).status).toBe(403);
  expect((await post(admin.headers)).status).toBeGreaterThanOrEqual(401);
  expect(rowsOf(a.db, "grants").length).toBe(2);

  const listed = await api(a, "GET", "/api/federation/shares");
  expect(listed.status).toBe(200);
  expect(listed.json).toHaveLength(2);

  const gone = await api(a, "DELETE", `/api/federation/shares/${seed.projectId}/${b.instanceId}`);
  expect(gone.status).toBe(200);
  updateTask(a.db, taskId, { title: "after revoke" }, seed.memberId);
  flushPending(a.db, a.home);
  await pull(b, a);
  expect(titleOf(b, taskId)).toBe("from B");
  expect(
    changesFor(a.db, b.instanceId, 0, 500).changes.some((ch) => ch.projectId === seed.projectId),
  ).toBe(false);
});
