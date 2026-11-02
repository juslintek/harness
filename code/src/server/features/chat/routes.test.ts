import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { createTask } from "../board/api";
import { createProject, grantProject } from "../orgs/api";
import { ensureProjectChannel } from "./api";

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

test("pages by a (createdAt, id) cursor so messages sharing a millisecond are not skipped", async () => {
  const { k, owner, channels } = await setup();
  const general = (await channels(owner)).find((c) => c.kind === "org");
  const path = `/api/channels/${general?.id}/messages`;
  const bodies = ["a", "b", "c", "d"];
  for (const body of bodies) await k.call(owner, "POST", path, { body });
  k.db.run("UPDATE messages SET created_at = 1000 WHERE channel_id = ?", [general?.id as string]);
  type Msg = { id: string; body: string; createdAt: number; author: { kind: string } | null };
  const seen: string[] = [];
  let query = "?limit=2";
  for (let page = 0; page < 5; page++) {
    const rows = (await (await k.call(owner, "GET", path + query)).json()) as Msg[];
    const first = rows[0];
    if (!first) break;
    seen.unshift(...rows.map((m) => m.body));
    query = `?limit=2&before=${first.createdAt}:${first.id}`;
  }
  expect(seen.toSorted()).toEqual(bodies);
  const legacy = await k.call(owner, "GET", `${path}?before=1000`);
  expect(await legacy.json()).toEqual([]);
  expect((await k.call(owner, "GET", `${path}?before=nope`)).status).toBe(400);
});

test("a message carries its author's handle and kind whatever org the reader is in", async () => {
  const { k, owner, channels } = await setup();
  const general = (await channels(owner)).find((c) => c.kind === "org");
  const path = `/api/channels/${general?.id}/messages`;
  const posted = await (await k.call(owner, "POST", path, { body: "hi" })).json();
  expect(posted.author).toMatchObject({ kind: "human" });
  expect(posted.author.handle).toBe(
    k.db
      .query<{ handle: string }, [string]>("SELECT handle FROM members WHERE id = ?")
      .get(posted.authorId)?.handle,
  );
});

test("a project channel lists grantee-org members too, naming the org only for a shared handle", async () => {
  const { k, owner, a } = await setup();
  const guest = await k.user();
  const b = k.org(guest, "beta");
  const project = createProject(k.db, { orgId: a.id, key: "web", name: "Web" });
  const channel = ensureProjectChannel(k.db, project.id);
  grantProject(k.db, project.id, b.id, "write", a.owner.id);
  const twin = await k.user();
  k.join(a.id, twin, "member", "own-beta");
  const list = async () =>
    (await (await k.call(owner, "GET", `/api/channels/${channel.id}/members`)).json()) as {
      handle: string;
      orgName?: string;
    }[];
  const before = await list();
  expect(before.map((m) => m.handle).sort()).toEqual(["own-acme", "own-beta", "own-beta"]);
  expect(before.filter((m) => m.handle === "own-beta").map((m) => m.orgName)).toEqual([
    "acme",
    "beta",
  ]);
  expect(before.find((m) => m.handle === "own-acme")?.orgName).toBeUndefined();
  const outsider = await k.user();
  k.org(outsider, "gamma");
  expect((await k.call(outsider, "GET", `/api/channels/${channel.id}/members`)).status).toBe(404);
});

test("thread replies page with limit and a before cursor, apart from the channel", async () => {
  const { k, owner, channels } = await setup();
  const general = (await channels(owner)).find((c) => c.kind === "org");
  const path = `/api/channels/${general?.id}/messages`;
  const root = await (await k.call(owner, "POST", path, { body: "root" })).json();
  for (const body of ["r1", "r2", "r3"]) {
    await k.call(owner, "POST", path, { body, threadRootId: root.id });
  }
  k.db.run("UPDATE messages SET created_at = 1000 WHERE thread_root_id = ?", [root.id]);
  type Msg = { id: string; body: string; createdAt: number };
  const thread = `${path}?thread=${root.id}`;
  const newest = (await (await k.call(owner, "GET", `${thread}&limit=2`)).json()) as Msg[];
  const oldest = newest[0] as Msg;
  const older = (await (
    await k.call(owner, "GET", `${thread}&limit=2&before=${oldest.createdAt}:${oldest.id}`)
  ).json()) as Msg[];
  expect([...older, ...newest].map((m) => m.body).toSorted()).toEqual(["r1", "r2", "r3"]);
  expect(older).toHaveLength(1);
  const top = (await (await k.call(owner, "GET", path)).json()) as Msg[];
  expect(top.map((m) => m.body)).toEqual(["root"]);
});
