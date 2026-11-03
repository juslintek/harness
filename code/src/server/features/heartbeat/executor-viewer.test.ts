import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { updateTask } from "../board/api";
import { setHalted } from "../runtimes/api";
import { setup, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("a wake queued before the agent was made a viewer is skipped at launch", async () => {
  const k = setup();
  const bob = k.agent("bob");
  stops.push(k.start());
  setHalted(k.db, true);
  updateTask(k.db, k.task("t").id, { assigneeId: bob.id }, k.human.id);
  await until(() => wakes(k.db, bob.id).length === 1);
  k.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", [bob.id]);
  setHalted(k.db, false);
  await until(() => wakes(k.db, bob.id)[0]?.status === "skipped");
  expect(JSON.parse(wakes(k.db, bob.id)[0]?.detail ?? "{}")).toEqual({ reason: "viewer" });
  expect(k.seen).toHaveLength(0);
});
