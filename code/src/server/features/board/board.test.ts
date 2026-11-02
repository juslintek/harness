import { expect, spyOn, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addAgentMember, createOrg, createProject, removeMember } from "../orgs/api";
import {
  addComment,
  addDependency,
  checkout,
  createTask,
  getTaskByNumber,
  listTasks,
  moveTask,
  onTaskChange,
  release,
  releaseAllFor,
  removeDependency,
  type TaskChange,
  taskDetail,
  updateTask,
  wireBoard,
} from "./api";

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const org = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const agent = (handle: string) =>
    addAgentMember(db, org.id, { agentId: "a", handle, displayName: handle, specialties: [] }).id;
  const project = (key: string) => createProject(db, { orgId: org.id, key, name: key }).id;
  return { db, org, agent, project };
}
const mk = (s: ReturnType<typeof setup>, projectId: string, title: string, extra = {}) =>
  createTask(s.db, { projectId, title, createdBy: "x", ...extra });

test("numbers are per org and increase across projects", () => {
  const s = setup();
  const [p1, p2] = [s.project("p1"), s.project("p2")] as [string, string];
  const other = createOrg(s.db, {
    name: "B",
    slug: "bee",
    ownerUserId: "u2",
    ownerName: "O",
    ownerHandle: "o2",
  });
  const p3 = createProject(s.db, { orgId: other.id, key: "p3", name: "p3" }).id;
  expect([mk(s, p1, "a").number, mk(s, p2, "b").number, mk(s, p1, "c").number]).toEqual([1, 2, 3]);
  expect(mk(s, p3, "d").number).toBe(1);
});

test("checkout by A then B gives held with holder A; A again is ok", () => {
  const s = setup();
  const [a, b] = [s.agent("aa"), s.agent("bb")] as [string, string];
  const t = mk(s, s.project("p1"), "t");
  const first = checkout(s.db, t.id, a);
  expect(first.ok && first.task.status).toBe("in_progress");
  expect(checkout(s.db, t.id, b)).toEqual({ ok: false, reason: "held", holderId: a });
  expect(checkout(s.db, t.id, a).ok).toBe(true);
  expect(release(s.db, t.id, b).ok).toBe(false);
  expect(release(s.db, t.id, a).ok).toBe(true);
  expect(checkout(s.db, t.id, b).ok).toBe(true);
});

test("checkout with an open dependency gives deps_open, and works once it is done", () => {
  const s = setup();
  const a = s.agent("aa");
  const p = s.project("p1");
  const dep = mk(s, p, "dep");
  const t = mk(s, p, "t");
  addDependency(s.db, t.id, dep.id);
  expect(checkout(s.db, t.id, a)).toEqual({ ok: false, reason: "deps_open", open: [dep.number] });
  moveTask(s.db, dep.id, "done", a);
  expect(checkout(s.db, t.id, a).ok).toBe(true);
  removeDependency(s.db, t.id, dep.id);
  expect(taskDetail(s.db, t.id).deps).toEqual([]);
});

test("dependency cycle is rejected", () => {
  const s = setup();
  const p = s.project("p1");
  const [x, y, z] = [mk(s, p, "x"), mk(s, p, "y"), mk(s, p, "z")] as const;
  addDependency(s.db, x.id, y.id);
  addDependency(s.db, y.id, z.id);
  expect(() => addDependency(s.db, z.id, x.id)).toThrow("cycle");
  expect(() => addDependency(s.db, x.id, x.id)).toThrow();
  expect(() => addDependency(s.db, x.id, mk(s, s.project("p2"), "w").id)).toThrow("same project");
});

test("parent must be in the same project", () => {
  const s = setup();
  const parent = mk(s, s.project("p1"), "parent");
  expect(() => mk(s, s.project("p2"), "child", { parentId: parent.id })).toThrow();
});

test("saving a task with the assignee it already has is an update, not a new assignment", () => {
  const s = setup();
  const [a, b] = [s.agent("aa"), s.agent("bb")] as [string, string];
  const t = mk(s, s.project("p1"), "t");
  const seen: TaskChange[] = [];
  const off = onTaskChange((c) => seen.push(c));
  updateTask(s.db, t.id, { assigneeId: b }, a);
  updateTask(s.db, t.id, { assigneeId: b, title: "t2" }, a);
  updateTask(s.db, t.id, { assigneeId: null }, a);
  off();
  expect(seen.map((x) => x.kind)).toEqual(["assigned", "updated", "assigned"]);
});

test("onTaskChange fires once per mutation with the right kind, never on a failed move", () => {
  const s = setup();
  const [a, b] = [s.agent("aa"), s.agent("bb")] as [string, string];
  const seen: TaskChange[] = [];
  const off = onTaskChange((c) => seen.push(c));
  const t = mk(s, s.project("p1"), "t");
  updateTask(s.db, t.id, { title: "t2" }, a);
  updateTask(s.db, t.id, { assigneeId: b }, a);
  const c = addComment(s.db, t.id, a, "hi");
  checkout(s.db, t.id, a);
  moveTask(s.db, t.id, "in_review", a);
  release(s.db, t.id, a);
  const before = seen.length;
  checkout(s.db, t.id, a);
  expect(moveTask(s.db, t.id, "todo", b).ok).toBe(false);
  expect(checkout(s.db, t.id, b).ok).toBe(false);
  off();
  expect(seen.slice(0, before).map((x) => x.kind)).toEqual([
    "created",
    "updated",
    "assigned",
    "commented",
    "checked_out",
    "moved",
    "released",
  ]);
  expect(seen[3]?.commentId).toBe(c.id);
  expect(seen.slice(before).map((x) => x.kind)).toEqual(["checked_out"]);
});

test("removing a member releases its tasks", () => {
  wireBoard(openDb(":memory:"));
  const s = setup();
  const a = s.agent("aa");
  const t = mk(s, s.project("p1"), "t", { assigneeId: a });
  checkout(s.db, t.id, a);
  removeMember(s.db, a);
  const after = taskDetail(s.db, t.id).task;
  expect(after.holderId).toBeNull();
  expect(after.assigneeId).toBeNull();
  expect(after.checkedOutAt).toBeNull();
});

test("releaseAllFor frees held tasks; lookup and filters work", () => {
  const s = setup();
  const [a, b] = [s.agent("aa"), s.agent("bb")] as [string, string];
  const p = s.project("p1");
  const t = mk(s, p, "t", { assigneeId: b });
  mk(s, p, "u");
  checkout(s.db, t.id, a);
  releaseAllFor(s.db, a);
  expect(getTaskByNumber(s.db, s.org.id, t.number)).toMatchObject({
    holderId: null,
    checkedOutAt: null,
  });
  expect(listTasks(s.db, p, { assigneeId: b }).map((x) => x.id)).toEqual([t.id]);
  expect(listTasks(s.db, p, { status: "in_progress" })).toHaveLength(1);
});

test("a throwing listener does not fail a committed change or starve later listeners", () => {
  const s = setup();
  const projectId = s.project("p1");
  const seen: string[] = [];
  const off = [
    onTaskChange(() => {
      throw new Error("boom");
    }),
    onTaskChange((change) => seen.push(change.kind)),
  ];
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const task = mk(s, projectId, "x");
  expect(quiet).toHaveBeenCalled();
  quiet.mockRestore();
  for (const stop of off) stop();
  expect(seen).toEqual(["created"]);
  expect(listTasks(s.db, projectId).map((t) => t.id)).toEqual([task.id]);
});
