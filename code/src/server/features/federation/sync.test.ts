import { afterAll, beforeAll, expect, test } from "bun:test";
import { addComment, addDependency, createTask, updateTask } from "../board/api";
import { postMessage } from "../chat/api";
import { listProjects } from "../orgs/api";
import { flushPending } from "./bodies";
import {
  bootNode,
  countChanges,
  type Node,
  pairNodes,
  pull,
  rowsOf,
  type Seed,
  seedProject,
  shareTo,
  stubMemberOf,
} from "./sync-kit";

let a: Node;
let b: Node;
let seed: Seed;
let taskId: string;

beforeAll(async () => {
  [a, b] = await Promise.all([bootNode(), bootNode()]);
  await pairNodes(a, b);
  seed = seedProject(a);
  const base = { projectId: seed.projectId, createdBy: seed.memberId };
  const task = createTask(a.db, { ...base, title: "first" });
  const other = createTask(a.db, { ...base, title: "second" });
  taskId = task.id;
  addDependency(a.db, other.id, task.id);
  addComment(a.db, task.id, seed.memberId, "hello from A");
  const channel = a.db
    .query<{ id: string }, [string]>("SELECT id FROM channels WHERE project_id = ?")
    .get(seed.projectId);
  postMessage(a.db, { channelId: channel?.id as string, authorId: seed.memberId, body: "hi team" });
});

afterAll(() => {
  a.stop();
  b.stop();
});

test("sharing a project exports its existing content to the peer with identical values", async () => {
  expect((await shareTo(a, seed, b, "write")).status).toBe(201);
  const stats = await pull(b, a);
  expect(stats.rejected).toBe(0);
  for (const table of ["tasks", "task_deps", "comments", "channels", "messages"]) {
    // Team and DM channels exist on A only when the chat hooks are wired; only project channels travel.
    const sent = rowsOf(a.db, table).filter((r) => table !== "channels" || r.kind === "project");
    expect(sent.length).toBeGreaterThan(0);
    expect(rowsOf(b.db, table)).toEqual(sent);
  }
  expect(rowsOf(b.db, "projects")[0]).toMatchObject({
    id: seed.projectId,
    home_instance: a.instanceId,
  });
  expect(rowsOf(a.db, "projects")[0]).toMatchObject({ home_instance: null });
});

test("the copy is listed for the instance admin through the stub org", () => {
  const stub = b.db
    .query<{ id: string }, [string]>("SELECT id FROM orgs WHERE home_instance = ?")
    .get(b.instanceId);
  expect(stub).not.toBeNull();
  expect(listProjects(b.db, stub?.id as string).map((p) => p.id)).toEqual([seed.projectId]);
});

test("an edit on the copy reaches the home and does not echo back", async () => {
  updateTask(b.db, taskId, { title: "edited on B" }, seed.memberId);
  const before = countChanges(a.db);
  await pull(a, b);
  expect(rowsOf(a.db, "tasks").find((t) => t.id === taskId)).toMatchObject({
    title: "edited on B",
  });
  flushPending(a.db, a.home);
  expect(countChanges(a.db)).toBe(before);
  expect((await pull(b, a)).applied).toBe(0);
});

test("a comment written on the copy reaches the home with its author", async () => {
  const author = stubMemberOf(b, b.admin.userId);
  addComment(b.db, taskId, author, "hello from B");
  await pull(a, b);
  expect(rowsOf(a.db, "comments").map((c) => c.body)).toContain("hello from B");
  expect(rowsOf(a.db, "members").map((m) => m.id)).toContain(author);
});
