import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { setup, specFor, until, wakes } from "./kit";
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
