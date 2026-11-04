import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { updateTask } from "../board/api";
import { runPending } from "./executor";
import { routeDeps, setup, specFor, until, wakes } from "./kit";
import { insertWake } from "./repo";

setDefaultTimeout(30_000);

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function retroFor(mcpEngines: string[]): { k: ReturnType<typeof setup>; memberId: string } {
  const k = setup();
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), mcp: mcpEngines.includes(id) });
  const dev = k.agent("dev");
  const task = k.task("shipped");
  insertWake(k.db, {
    memberId: dev.id,
    reason: "retro",
    taskId: task.id,
    detail: { taskId: task.id },
    causedBy: null,
  });
  stops.push(k.start());
  return { k, memberId: dev.id };
}

test("a retro wake is not run when the member has no engine with MCP", async () => {
  const { k, memberId } = retroFor([]);
  await until(() => wakes(k.db, memberId).every((w) => w.status === "failed"));
  expect(k.seen.length).toBe(0);
  expect(JSON.stringify(wakes(k.db, memberId)[0]?.detail)).toContain("no engine with MCP");
});

test("a retro wake runs on the engine that has MCP, not the member's own", async () => {
  const { k, memberId } = retroFor(["fake2"]);
  await until(() => wakes(k.db, memberId).every((w) => w.status === "done"));
  const runs = k.db.query<{ agent_id: string }, []>("SELECT agent_id FROM runs").all();
  expect(runs.map((r) => r.agent_id)).toEqual(["fake2"]);
});

test("a memory-only wake that fails routing does not hold back the member's assignment in the same pass", async () => {
  const k = setup();
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), mcp: false });
  const dev = k.agent("dev");
  const shipped = k.task("shipped");
  insertWake(k.db, {
    memberId: dev.id,
    reason: "retro",
    taskId: shipped.id,
    detail: { taskId: shipped.id },
    causedBy: null,
  });
  const next = k.task("next");
  updateTask(k.db, next.id, { assigneeId: dev.id }, k.human.id);
  await Bun.sleep(5);
  insertWake(k.db, { memberId: dev.id, reason: "assignment", taskId: next.id, causedBy: null });
  await runPending(k.db, { runDeps: k.runDeps, home: k.home, routeDeps });
  const status = (reason: string) => wakes(k.db, dev.id).find((w) => w.reason === reason)?.status;
  expect(status("retro")).toBe("failed");
  expect(status("assignment")).toBe("done");
  expect(k.seen).toHaveLength(1);
});
