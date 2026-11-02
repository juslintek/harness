import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { createProject } from "../orgs/api";

async function setup() {
  const k = bootApi();
  const owner = await k.user();
  const a = k.org(owner, "acme");
  const channels = async (who: typeof owner, slug = "acme") =>
    (await (await k.call(who, "GET", `/api/orgs/${slug}/channels`)).json()) as {
      id: string;
      kind: string;
    }[];
  return { k, owner, a, channels };
}

test("a dm is invisible to non-participants: posting is 404, reading too", async () => {
  const { k, owner, a } = await setup();
  const [bob, carol] = [await k.user(), await k.user()] as [typeof owner, typeof owner];
  const bobMember = k.join(a.id, bob, "member", "bob");
  k.join(a.id, carol, "member", "carol");
  const dm = await (
    await k.call(owner, "POST", "/api/orgs/acme/dms", { memberId: bobMember.id })
  ).json();
  const path = `/api/channels/${dm.id}/messages`;
  expect((await k.call(owner, "POST", path, { body: "psst" })).status).toBe(201);
  expect((await k.call(bob, "GET", path)).status).toBe(200);
  expect((await k.call(carol, "POST", path, { body: "hi" })).status).toBe(404);
  expect((await k.call(carol, "GET", path)).status).toBe(404);
  expect((await k.call(carol, "POST", `${path.replace("/messages", "/read")}`)).status).toBe(404);
});

test("a viewer reads the org channel but cannot post, and bodies are validated", async () => {
  const { k, owner, a, channels } = await setup();
  const viewer = await k.user();
  k.join(a.id, viewer, "viewer", "view");
  const general = (await channels(viewer)).find((c) => c.kind === "org");
  const path = `/api/channels/${general?.id}/messages`;
  expect((await k.call(viewer, "GET", path)).status).toBe(200);
  expect((await k.call(viewer, "POST", path, { body: "x" })).status).toBe(403);
  expect((await k.call(viewer, "POST", `/api/channels/${general?.id}/read`)).status).toBe(200);
  expect((await k.call(owner, "POST", path, { body: "" })).status).toBe(400);
  const root = await (await k.call(owner, "POST", path, { body: "root" })).json();
  const reply = await k.call(owner, "POST", path, { body: "re", threadRootId: root.id });
  expect(reply.status).toBe(201);
  const thread = await (await k.call(owner, "GET", `${path}?thread=${root.id}`)).json();
  expect(thread).toHaveLength(1);
  expect((await k.call(owner, "GET", `${path}?before=abc`)).status).toBe(400);
});

test("groups only admit org members, and a stranger cannot list another org's channels", async () => {
  const { k, owner, a } = await setup();
  const bob = await k.user();
  const bobMember = k.join(a.id, bob, "member", "bob");
  const group = await k.call(owner, "POST", "/api/orgs/acme/groups", {
    name: "Ops",
    memberIds: [bobMember.id],
  });
  expect(group.status).toBe(201);
  const outsider = await k.user();
  k.org(outsider, "beta");
  expect((await k.call(outsider, "GET", "/api/orgs/acme/channels")).status).toBe(404);
  const bad = await k.call(owner, "POST", "/api/orgs/acme/groups", {
    name: "Bad",
    memberIds: ["x"],
  });
  expect(bad.status).toBe(400);
});

test("a #n in a message links the real board task of the channel's org", async () => {
  const { k, owner, a, channels } = await setup();
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  const task = createTask(k.db, { projectId: project.id, title: "t", createdBy: a.owner.id });
  const general = (await channels(owner)).find((c) => c.kind === "org");
  const path = `/api/channels/${general?.id}/messages`;
  const posted = await (await k.call(owner, "POST", path, { body: `see #${task.number}` })).json();
  expect(posted.taskIds).toEqual([task.id]);
  const listed = await (await k.call(owner, "GET", path)).json();
  expect(listed.at(-1).taskIds).toEqual([task.id]);
  expect(listed.at(-1).tasks).toEqual([{ number: task.number, projectId: project.id }]);
});

test("channel members lists only who can read the channel, and 404s for outsiders", async () => {
  const { k, owner, a, channels } = await setup();
  const [bob, carol] = [await k.user(), await k.user()] as [typeof owner, typeof owner];
  const bobMember = k.join(a.id, bob, "member", "bob");
  k.join(a.id, carol, "member", "carol");
  const dm = await (
    await k.call(owner, "POST", "/api/orgs/acme/dms", { memberId: bobMember.id })
  ).json();
  const handles = async (who: typeof owner, id: string) =>
    (
      (await (await k.call(who, "GET", `/api/channels/${id}/members`)).json()) as {
        handle: string;
      }[]
    )
      .map((m) => m.handle)
      .sort();
  expect(await handles(bob, dm.id)).toHaveLength(2);
  expect(await handles(bob, dm.id)).toContain("bob");
  expect((await k.call(carol, "GET", `/api/channels/${dm.id}/members`)).status).toBe(404);
  const general = (await channels(owner)).find((c) => c.kind === "org");
  expect(await handles(carol, general?.id ?? "")).toContain("carol");
  expect(await handles(carol, general?.id ?? "")).toHaveLength(3);
});
