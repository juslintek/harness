import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { addAgentMember, createOrg, createProject } from "../orgs/api";
import { checkout, createTask, getTask, listTasks, moveTask } from "./api";

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
  const member = addAgentMember(db, org.id, {
    agentId: "a",
    handle: "aa",
    displayName: "aa",
    specialties: [],
  }).id;
  const projectId = createProject(db, { orgId: org.id, key: "p1", name: "p1" }).id;
  const mk = (title: string, extra = {}) =>
    createTask(db, { projectId, title, createdBy: member, ...extra });
  return { db, member, mk };
}

test("done with an open subtask gives children_open", () => {
  const { db, member, mk } = setup();
  const parent = mk("parent");
  const child = mk("child", { parentId: parent.id });
  expect(moveTask(db, parent.id, "done", member)).toEqual({
    ok: false,
    reason: "children_open",
    open: [child.number],
  });
  moveTask(db, child.id, "cancelled", member);
  expect(moveTask(db, parent.id, "done", member).ok).toBe(true);
});

test("move to todo clears holder, in_review keeps it", () => {
  const { db, member, mk } = setup();
  const t = mk("t");
  checkout(db, t.id, member);
  expect(getTask(db, t.id)?.checkedOutAt).not.toBeNull();
  moveTask(db, t.id, "in_review", member);
  expect(getTask(db, t.id)).toMatchObject({ status: "in_review", holderId: member });
  moveTask(db, t.id, "blocked", member);
  expect(getTask(db, t.id)?.holderId).toBe(member);
  moveTask(db, t.id, "todo", member);
  expect(getTask(db, t.id)).toMatchObject({ status: "todo", holderId: null, checkedOutAt: null });
  expect(moveTask(db, t.id, "in_progress", member).ok).toBe(true);
  expect(moveTask(db, "nope", "todo", member)).toEqual({ ok: false, reason: "not_found" });
});

test("rank: move before X lands between X and its predecessor", () => {
  const { db, member, mk } = setup();
  const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => mk(n, { status: "todo" })) as [
    ReturnType<typeof mk>,
    ReturnType<typeof mk>,
    ReturnType<typeof mk>,
    ReturnType<typeof mk>,
  ];
  const moved = moveTask(db, d.id, "todo", member, { beforeId: c.id });
  expect(moved.ok && moved.task.rank).toBeGreaterThan(b.rank);
  expect(moved.ok && moved.task.rank).toBeLessThan(c.rank);
  expect(listTasks(db, a.projectId, { status: "todo" }).map((t) => t.title)).toEqual([
    "a",
    "b",
    "d",
    "c",
  ]);
  moveTask(db, c.id, "todo", member, { beforeId: a.id });
  expect(listTasks(db, a.projectId, { status: "todo" })[0]?.title).toBe("c");
  moveTask(db, a.id, "todo", member);
  expect(listTasks(db, a.projectId, { status: "todo" }).at(-1)?.title).toBe("a");
});

test("a beforeId in another status is ignored and the task goes to the end of the target lane", () => {
  const { db, member, mk } = setup();
  const lane = mk("lane", { status: "todo" });
  const other = mk("other", { status: "backlog" });
  const moving = mk("moving", { status: "backlog" });
  const moved = moveTask(db, moving.id, "todo", member, { beforeId: other.id });
  expect(moved.ok && moved.task.rank).toBeGreaterThan(lane.rank);
  expect(listTasks(db, lane.projectId, { status: "todo" }).map((t) => t.title)).toEqual([
    "lane",
    "moving",
  ]);
});

test("sixty inserts into one gap keep a strict order by renumbering the lane when the gap runs out", () => {
  const { db, member, mk } = setup();
  const first = mk("first");
  const last = mk("last");
  for (const t of [first, last]) moveTask(db, t.id, "todo", member);
  const titles = ["first"];
  for (let i = 0; i < 60; i++) {
    const task = mk(`x${i}`);
    expect(moveTask(db, task.id, "todo", member, { beforeId: last.id }).ok).toBe(true);
    titles.push(`x${i}`);
  }
  const lane = listTasks(db, first.projectId, { status: "todo" });
  expect(lane.map((t) => t.title)).toEqual([...titles, "last"]);
  const ranks = lane.map((t) => t.rank);
  expect(new Set(ranks).size).toBe(ranks.length);
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
});
