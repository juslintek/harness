import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { createProject, grantProject } from "../orgs/api";

async function setup() {
  const k = bootApi();
  const owner = await k.user();
  const a = k.org(owner, "acme");
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  return { k, owner, a, project, base: `/api/projects/${project.id}/tasks` };
}

test("a viewer reads tasks but cannot create them", async () => {
  const { k, a, base } = await setup();
  const viewer = await k.user();
  k.join(a.id, viewer, "viewer", "view");
  expect((await k.call(viewer, "GET", base)).status).toBe(200);
  expect((await k.call(viewer, "POST", base, { title: "nope" })).status).toBe(403);
});

test("a member of another org gets 404 for a task, a grantee reads but cannot write", async () => {
  const { k, owner, a, project, base } = await setup();
  const made = await (await k.call(owner, "POST", base, { title: "secret" })).json();
  const stranger = await k.user();
  k.org(stranger, "beta");
  expect((await k.call(stranger, "GET", `/api/tasks/${made.id}`)).status).toBe(404);
  expect((await k.call(stranger, "GET", base)).status).toBe(404);

  const betaOrg = k.db.query<{ id: string }, []>("SELECT id FROM orgs WHERE slug = 'beta'").get();
  grantProject(k.db, project.id, betaOrg?.id as string, "read", a.owner.id);
  expect((await k.call(stranger, "GET", base)).status).toBe(200);
  expect((await k.call(stranger, "GET", `/api/tasks/${made.id}`)).status).toBe(200);
  expect((await k.call(stranger, "POST", base, { title: "x" })).status).toBe(403);
  expect((await k.call(stranger, "POST", `/api/tasks/${made.id}/checkout`)).status).toBe(403);
});

test("moving into in_progress while another member holds the task is 409 held", async () => {
  const { k, owner, a, base } = await setup();
  const other = await k.user();
  k.join(a.id, other, "member", "mem");
  const task = await (await k.call(owner, "POST", base, { title: "t" })).json();
  expect((await k.call(owner, "POST", `/api/tasks/${task.id}/checkout`)).status).toBe(200);
  const move = await k.call(other, "POST", `/api/tasks/${task.id}/move`, { to: "in_progress" });
  expect(move.status).toBe(409);
  expect(await move.json()).toMatchObject({ ok: false, reason: "held", holderId: a.owner.id });
  expect((await k.call(other, "POST", `/api/tasks/${task.id}/release`)).status).toBe(409);
  expect((await k.call(owner, "POST", `/api/tasks/${task.id}/release`)).status).toBe(200);
  expect((await k.call(other, "POST", `/api/tasks/${task.id}/move`, { to: "todo" })).status).toBe(
    200,
  );
});

test("patch, dependencies and comments work and keep their bounds", async () => {
  const { k, owner, a, base } = await setup();
  const one = await (await k.call(owner, "POST", base, { title: "one" })).json();
  const two = await (await k.call(owner, "POST", base, { title: "two", parentId: one.id })).json();
  const patched = await k.call(owner, "PATCH", `/api/tasks/${one.id}`, { description: "d" });
  expect(await patched.json()).toMatchObject({ title: "one", description: "d" });
  expect((await k.call(owner, "PATCH", `/api/tasks/${one.id}`, { status: "done" })).status).toBe(
    400,
  );
  const dep = (method: string, id: string) =>
    k.call(owner, method, `/api/tasks/${one.id}/deps`, { dependsOn: id });
  expect((await dep("POST", two.id)).status).toBe(200);
  expect((await dep("POST", "missing")).status).toBe(400);
  const detail = await (await k.call(owner, "GET", `/api/tasks/${one.id}`)).json();
  expect(detail.deps.map((t: { id: string }) => t.id)).toEqual([two.id]);
  expect((await dep("DELETE", two.id)).status).toBe(200);
  const comment = await k.call(owner, "POST", `/api/tasks/${one.id}/comments`, { body: "hi" });
  expect(comment.status).toBe(201);
  const assign = await k.call(owner, "PATCH", `/api/tasks/${one.id}`, { assigneeId: a.owner.id });
  expect((await assign.json()).assigneeId).toBe(a.owner.id);
  const foreign = await k.call(owner, "PATCH", `/api/tasks/${one.id}`, { assigneeId: "nobody" });
  expect(foreign.status).toBe(400);
});
