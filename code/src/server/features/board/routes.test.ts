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

test("the project dependency list gives edges for the board counts", async () => {
  const { k, owner, project, base } = await setup();
  const one = await (await k.call(owner, "POST", base, { title: "one" })).json();
  const two = await (await k.call(owner, "POST", base, { title: "two" })).json();
  await k.call(owner, "POST", `/api/tasks/${two.id}/deps`, { dependsOn: one.id });
  const res = await k.call(owner, "GET", `/api/projects/${project.id}/deps`);
  expect(await res.json()).toEqual([{ taskId: two.id, dependsOn: one.id }]);
  const stranger = await k.user();
  k.org(stranger, "beta");
  expect((await k.call(stranger, "GET", `/api/projects/${project.id}/deps`)).status).toBe(404);
});

test("an assignee must be able to write, and a domain refusal is a 400 with its message", async () => {
  const { k, owner, a, base } = await setup();
  const reader = await k.user();
  const viewerMember = k.join(a.id, reader, "viewer", "vee");
  const made = await (await k.call(owner, "POST", base, { title: "t" })).json();
  const patch = await k.call(owner, "PATCH", `/api/tasks/${made.id}`, {
    assigneeId: viewerMember.id,
  });
  expect(patch.status).toBe(400);
  const create = await k.call(owner, "POST", base, { title: "n", assigneeId: viewerMember.id });
  expect(create.status).toBe(400);
  const bad = await k.call(owner, "POST", base, { title: "n", parentId: "missing" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "parent must be in the project" });
});

test("a grantee sees the handle of an assignee from the owning org", async () => {
  const { k, owner, a, project, base } = await setup();
  const guest = await k.user();
  const betaOrg = k.org(guest, "beta");
  grantProject(k.db, project.id, betaOrg.id, "write", a.owner.id);
  const made = await (await k.call(owner, "POST", base, { title: "t" })).json();
  await k.call(owner, "PATCH", `/api/tasks/${made.id}`, { assigneeId: a.owner.id });
  const seen = await (await k.call(guest, "GET", `/api/tasks/${made.id}`)).json();
  expect(seen.task.assignee).toMatchObject({ kind: "human" });
  expect(seen.task.assignee.handle).toBe("own-acme");
  await k.call(owner, "POST", `/api/tasks/${made.id}/comments`, { body: "hello" });
  const again = await (await k.call(guest, "GET", `/api/tasks/${made.id}`)).json();
  expect(again.comments[0].author.handle).toBe("own-acme");
});

test("project members lists writers of the owning and grantee orgs, never readers or strangers", async () => {
  const { k, owner, a, project } = await setup();
  const viewer = await k.user();
  k.join(a.id, viewer, "viewer", "view");
  const guest = await k.user();
  k.org(guest, "beta");
  const beta = k.db.query<{ id: string }, []>("SELECT id FROM orgs WHERE slug = 'beta'").get();
  const outsider = await k.user();
  k.org(outsider, "gamma");
  const url = `/api/projects/${project.id}/members`;
  expect((await k.call(outsider, "GET", url)).status).toBe(404);
  const handles = async (): Promise<string[]> =>
    ((await (await k.call(owner, "GET", url)).json()) as { handle: string }[]).map((m) => m.handle);
  expect(await handles()).not.toContain("view");
  expect((await handles()).length).toBe(1);
  grantProject(k.db, project.id, beta?.id as string, "write", a.owner.id);
  const listed = (await (await k.call(guest, "GET", url)).json()) as {
    handle: string;
    orgName: string;
  }[];
  expect(listed.map((m) => m.orgName).sort()).toEqual(["acme", "beta"]);
  expect(listed.some((m) => m.handle === "view")).toBe(false);
});
