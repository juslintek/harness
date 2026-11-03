import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { createTask, updateTask } from "../board/api";
import { createPosition } from "../orgs/api";
import { type Kit, setup, until, wakes } from "./kit";
import { buildPrompt } from "./prompt";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function lead(k: Kit): { boss: ReturnType<Kit["agent"]>; dev: ReturnType<Kit["agent"]> } {
  const boss = k.agent("boss");
  const dev = k.agent("dev");
  const pos = createPosition(k.db, {
    orgId: k.orgId,
    title: "Lead",
    memberId: boss.id,
    isManager: true,
  });
  createPosition(k.db, { orgId: k.orgId, title: "Dev", memberId: dev.id, reportsTo: pos.id });
  return { boss, dev };
}

const assignments = (k: Kit, memberId: string): Record<string, string | null>[] =>
  wakes(k.db, memberId).filter((w) => w.reason === "assignment");

test("manager prompt contains task_delegate and HARNESS_SCRATCH", () => {
  const k = setup();
  const { boss } = lead(k);
  const prompt = buildPrompt(k.db, boss, []);
  expect(prompt).toContain("`team_roster`");
  expect(prompt).toContain("`task_delegate`");
  expect(prompt).toContain('git -C "$HARNESS_SCRATCH" checkout --detach');
  expect(prompt).toContain("Your worktree is read-only on purpose.");
});

test("manager run ending without a subtask gets one nudge wake; a second ending gets none", async () => {
  const k = setup();
  const { boss } = lead(k);
  stops.push(k.start());
  const task = k.task("Build it");
  updateTask(k.db, task.id, { assigneeId: boss.id }, k.human.id);
  await until(
    () =>
      assignments(k, boss.id).length === 2 &&
      assignments(k, boss.id).every((w) => w.status === "done"),
  );
  await Bun.sleep(200);
  const rows = assignments(k, boss.id);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.detail).not.toContain("nudge");
  expect(JSON.parse(rows[1]?.detail as string)).toMatchObject({ nudge: "delegate" });
  expect(k.seen[1]?.prompt).toContain(
    `You ended without delegating #${task.number}. Delegate it now with task_delegate`,
  );
});

test("no nudge when the manager split the task", async () => {
  const k = setup();
  const { boss, dev } = lead(k);
  k.runDeps.lane = async (ctx) => {
    if (ctx.prompt.includes("Build it"))
      createTask(k.db, {
        projectId: k.projectId,
        title: "piece",
        createdBy: boss.id,
        parentId: task.id,
        assigneeId: dev.id,
      });
    return { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
  };
  stops.push(k.start());
  const task = k.task("Build it");
  updateTask(k.db, task.id, { assigneeId: boss.id }, k.human.id);
  await until(() => assignments(k, dev.id).length === 1);
  await Bun.sleep(200);
  expect(assignments(k, boss.id)).toHaveLength(1);
});

test("scratch checkout exists during a manager run and is removed at run end", async () => {
  const k = setup();
  const { boss } = lead(k);
  const seen: string[] = [];
  k.runDeps.lane = async (ctx) => {
    const path = ctx.env.HARNESS_SCRATCH ?? "";
    seen.push(path, existsSync(`${path}/.git`) ? "present" : "missing");
    return { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
  };
  stops.push(k.start());
  const task = k.task("Build it");
  updateTask(k.db, task.id, { assigneeId: boss.id }, k.human.id);
  await until(() => seen.length >= 2);
  expect(seen[0]).toContain("scratch-checkouts/");
  expect(seen[1]).toBe("present");
  await until(() => !existsSync(seen[0] as string));
});
