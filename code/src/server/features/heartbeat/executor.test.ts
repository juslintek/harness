import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { updateTask } from "../board/api";
import { postMessage } from "../chat/api";
import { createPosition } from "../orgs/api";
import { setHalted } from "../runtimes/api";
import { wakeNow } from "./api";
import { setup, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("a halted harness leaves wakes pending until it is un-halted", async () => {
  const k = setup();
  const b = k.agent("bob");
  stops.push(k.start());
  setHalted(k.db, true);
  const task = k.task("t");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id).length === 1);
  await Bun.sleep(100);
  expect(wakes(k.db, b.id)[0]?.status).toBe("pending");
  expect(k.seen).toHaveLength(0);
  setHalted(k.db, false);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  expect(k.seen).toHaveLength(1);
});

test("only a manager member gets approvals_decide", async () => {
  const k = setup();
  const boss = k.agent("boss");
  const dev = k.agent("dev");
  createPosition(k.db, { orgId: k.orgId, title: "Lead", memberId: boss.id, isManager: true });
  stops.push(k.start());
  const task = k.task("t");
  updateTask(k.db, task.id, { assigneeId: boss.id }, k.human.id);
  updateTask(k.db, task.id, { assigneeId: dev.id }, k.human.id);
  await until(() => k.seen.length === 2);
  const scopesOf = (id: string): string[] => k.seen.find((s) => s.memberId === id)?.scopes ?? [];
  expect(scopesOf(boss.id)).toContain("approvals_decide");
  expect(scopesOf(dev.id)).not.toContain("approvals_decide");
});

test("the prompt names the task number and the channel, and says who the agent is", async () => {
  const k = setup();
  const b = k.agent("bob");
  createPosition(k.db, { orgId: k.orgId, title: "Backend dev", memberId: b.id });
  stops.push(k.start());
  const task = k.task("Fix login");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  postMessage(k.db, { channelId: k.teamChannel.id, authorId: k.human.id, body: "@bob status?" });
  await until(() => k.seen.length === 2);
  const [first, second] = k.seen;
  expect(first?.prompt).toContain(`#${task.number}`);
  expect(first?.prompt).toContain("Fix login");
  expect(first?.prompt).toContain("@bob in the org Acme");
  expect(first?.prompt).toContain("Backend dev");
  expect(first?.prompt).toContain("Do not stop without updating the task status.");
  expect(second?.prompt).toContain(`#${k.teamChannel.name}`);
  expect(second?.prompt).toContain("status?");
});

test("runs with no project repo use a git-initialised scratch repo of the org", async () => {
  const k = setup();
  const b = k.agent("bob");
  stops.push(k.start());
  wakeNow(k.db, b.id, "user:u1");
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const run = k.db.query<{ repo: string }, []>("SELECT repo FROM runs").get();
  expect(run?.repo).toBe(join(k.home, "scratch", k.orgId));
  expect(existsSync(join(k.home, "scratch", k.orgId, ".git"))).toBe(true);
  expect(wakes(k.db, b.id)[0]?.reason).toBe("run_now");
});

test("a failed run marks its wakes failed", async () => {
  const k = setup();
  const b = k.agent("bob");
  k.runDeps.resolveSpec = () => null;
  stops.push(k.start());
  wakeNow(k.db, b.id, "user:u1");
  await until(() => wakes(k.db, b.id)[0]?.status === "failed");
  expect(wakes(k.db, b.id)[0]?.detail).toContain("unknown agent");
});

test("the schedule tick wakes an agent whose last wake is older than its heartbeat", async () => {
  const k = setup();
  const b = k.agent("bob");
  const idle = k.agent("idle");
  k.db.run("UPDATE members SET heartbeat_minutes = 60, created_at = ? WHERE id = ?", [
    Date.now() - 2 * 3_600_000,
    b.id,
  ]);
  k.db.run("UPDATE members SET heartbeat_minutes = 60 WHERE id = ?", [idle.id]);
  stops.push(k.start());
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  await Bun.sleep(100);
  expect(wakes(k.db, b.id).map((w) => w.reason)).toEqual(["schedule"]);
  expect(wakes(k.db, idle.id)).toHaveLength(0);
});

test("a paused agent gets no wakes and run now is refused", () => {
  const k = setup();
  const b = k.agent("bob");
  k.db.run("UPDATE members SET paused = 1 WHERE id = ?", [b.id]);
  stops.push(k.start());
  const task = k.task("t");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);
  expect(wakes(k.db, b.id)).toHaveLength(0);
  expect(() => wakeNow(k.db, b.id, "user:u1")).toThrow("paused");
});
