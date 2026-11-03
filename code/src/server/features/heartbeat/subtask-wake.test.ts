import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createTask, moveTask, updateTask } from "../board/api";
import { type Kit, setup, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function split(k: Kit) {
  const lead = k.agent("lead");
  const dev = k.agent("dev");
  const parent = k.task("parent");
  updateTask(k.db, parent.id, { assigneeId: lead.id }, k.human.id);
  const child = createTask(k.db, {
    projectId: k.projectId,
    title: "child",
    createdBy: k.human.id,
    parentId: parent.id,
  });
  updateTask(k.db, child.id, { assigneeId: dev.id }, k.human.id);
  return { lead, dev, parent, child };
}

const reasons = (k: Kit, memberId: string): string[] =>
  wakes(k.db, memberId).map((w) => w.reason as string);

test("a subtask moved to done wakes the parent's assignee on the parent", async () => {
  const k = setup();
  const { lead, dev, parent, child } = split(k);
  stops.push(k.start());
  await until(() => wakes(k.db, lead.id).every((w) => w.status === "done"));
  moveTask(k.db, child.id, "done", dev.id);
  await until(() => reasons(k, lead.id).includes("subtask"));
  const row = k.db
    .query<{ task_id: string; caused_by: string; detail: string }, [string]>(
      "SELECT task_id, caused_by, detail FROM wakeups WHERE reason = 'subtask' AND member_id = ?",
    )
    .get(lead.id);
  expect(row).toMatchObject({ task_id: parent.id, caused_by: dev.id });
  expect(row?.detail).toContain(`#${child.number} child moved to done`);
});

test("a subtask moved to in_progress does not wake the parent's assignee", async () => {
  const k = setup();
  const { lead, dev, child } = split(k);
  stops.push(k.start());
  moveTask(k.db, child.id, "in_progress", dev.id);
  await Bun.sleep(150);
  expect(reasons(k, lead.id)).not.toContain("subtask");
});

test("the parent's assignee moving the subtask itself does not wake them", async () => {
  const k = setup();
  const { lead, child } = split(k);
  stops.push(k.start());
  moveTask(k.db, child.id, "done", lead.id);
  await Bun.sleep(150);
  expect(reasons(k, lead.id)).not.toContain("subtask");
});

test("a top-level task moved to done wakes nobody for a subtask", async () => {
  const k = setup();
  const { lead, dev, parent } = split(k);
  stops.push(k.start());
  moveTask(k.db, parent.id, "done", dev.id);
  await Bun.sleep(150);
  expect(reasons(k, lead.id)).not.toContain("subtask");
});

test("moving a subtask that is already done wakes nobody again", async () => {
  const k = setup();
  const { lead, dev, child } = split(k);
  stops.push(k.start());
  await until(() => wakes(k.db, lead.id).every((w) => w.status === "done"));
  moveTask(k.db, child.id, "done", dev.id);
  await until(() => reasons(k, lead.id).includes("subtask"));
  await until(() => wakes(k.db, lead.id).every((w) => w.status === "done"));
  moveTask(k.db, child.id, "done", dev.id);
  await Bun.sleep(150);
  expect(reasons(k, lead.id).filter((r) => r === "subtask")).toHaveLength(1);
});
