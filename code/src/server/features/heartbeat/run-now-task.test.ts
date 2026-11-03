import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { addAgentMember, createProject, grantProject } from "../orgs/api";
import { wakeNow } from "./api";
import { setup, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function routeSetup() {
  const k = bootApi();
  const owner = await k.user({ stepUp: true });
  const a = k.org(owner, "acme");
  const agent = addAgentMember(k.db, a.id, {
    agentId: "fake",
    handle: "bob",
    displayName: "bob",
    specialties: [],
  });
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  const task = createTask(k.db, { projectId: project.id, title: "t", createdBy: a.owner.id });
  return { k, owner, a, agent, path: `/api/members/${agent.id}/wake`, task };
}

test("run now with a task id stores it on the wake", async () => {
  const { k, owner, agent, path, task } = await routeSetup();
  const res = await k.call(owner, "POST", path, { taskId: task.id });
  expect(res.status).toBe(202);
  const stored = k.db
    .query<{ task_id: string | null }, [string]>("SELECT task_id FROM wakeups WHERE member_id = ?")
    .all(agent.id);
  expect(stored).toEqual([{ task_id: task.id }]);
});

test("run now rejects an unknown task, a malformed body and a task the agent cannot write", async () => {
  const { k, owner, a, agent, path } = await routeSetup();
  expect((await k.call(owner, "POST", path, { taskId: "missing" })).status).toBe(400);
  expect((await k.call(owner, "POST", path, { taskId: 5 })).status).toBe(400);
  const other = await k.user();
  const beta = k.org(other, "beta");
  const theirs = createProject(k.db, { orgId: beta.id, key: "b", name: "B" });
  const foreign = createTask(k.db, { projectId: theirs.id, title: "x", createdBy: beta.owner.id });
  expect((await k.call(owner, "POST", path, { taskId: foreign.id })).status).toBe(400);
  grantProject(k.db, theirs.id, a.id, "read", beta.owner.id);
  expect((await k.call(owner, "POST", path, { taskId: foreign.id })).status).toBe(403);
  expect(wakes(k.db, agent.id)).toHaveLength(0);
});

test("a run now wake with a task runs in the task's project and names the task", async () => {
  const k = setup();
  const bob = k.agent("bob");
  stops.push(k.start());
  const task = k.task("Fix login");
  wakeNow(k.db, bob.id, "user:u1", task.id);
  await until(() => wakes(k.db, bob.id)[0]?.status === "done");
  const run = k.db.query<{ project_id: string }, []>("SELECT project_id FROM runs").get();
  expect(run?.project_id).toBe(k.projectId);
  expect(k.seen[0]?.prompt).toContain("Fix login");
});
