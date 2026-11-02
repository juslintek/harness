import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createTask } from "../board/api";
import {
  addAgentMember,
  addHumanMember,
  createOrg,
  createProject,
  createTeam,
  grantProject,
  type MemberRow,
} from "../orgs/api";
import {
  ChatError,
  type ChatEvent,
  channelAccess,
  channelMemberIds,
  createGroup,
  ensureProjectChannel,
  ensureTeamChannel,
  listChannels,
  listMessages,
  markRead,
  onMessage,
  openDm,
  postMessage,
  wireChat,
} from "./api";

type Db = ReturnType<typeof openDb>;

function setup(): { db: Db; org: string; owner: MemberRow } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const o = createOrg(db, {
    name: "Acme",
    slug: "acme",
    ownerUserId: "u1",
    ownerName: "Owner",
    ownerHandle: "owner",
  });
  const owner = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(o.id);
  return { db, org: o.id, owner: { id: owner?.id as string } as MemberRow };
}

const human = (db: Db, org: string, handle: string, role: "member" | "viewer" = "member") =>
  addHumanMember(db, org, `user-${handle}`, handle, handle, role);

function general(db: Db, memberId: string) {
  const c = listChannels(db, memberId).find((x) => x.kind === "org");
  if (!c) throw new Error("no org channel");
  return c;
}

function gitProject(db: Db, orgId: string) {
  const repo = mkdtempSync(join(tmpdir(), "chat-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const project = createProject(db, { orgId, key: "web", name: "Web", repo });
  ensureProjectChannel(db, project.id);
  return project;
}

test("org creation makes #general and a channel for the Core team", () => {
  const { db, owner } = setup();
  const channels = listChannels(db, owner.id);
  expect(channels.map((c) => [c.kind, c.name])).toEqual([
    ["org", "general"],
    ["team", "Core"],
  ]);
});

test("dm is idempotent and has two members", () => {
  const { db, org, owner } = setup();
  const bob = human(db, org, "bob");
  const a = openDm(db, owner.id, bob.id);
  const b = openDm(db, bob.id, owner.id);
  expect(b.id).toBe(a.id);
  expect(channelMemberIds(db, a.id).sort()).toEqual([owner.id, bob.id].sort());
  expect(() => openDm(db, owner.id, owner.id)).toThrow();
});

test("viewer can read org channel but cannot post", () => {
  const { db, org, owner } = setup();
  const viewer = human(db, org, "vera", "viewer");
  const ch = general(db, owner.id);
  expect(channelAccess(db, viewer.id, ch.id)).toBe("read");
  expect(() => postMessage(db, { channelId: ch.id, authorId: viewer.id, body: "hi" })).toThrow(
    ChatError,
  );
});

test("outsider cannot read a group", () => {
  const { db, org, owner } = setup();
  const bob = human(db, org, "bob");
  const carl = human(db, org, "carl");
  const group = createGroup(db, org, "plans", [bob.id], owner.id);
  expect(channelAccess(db, bob.id, group.id)).toBe("write");
  expect(channelAccess(db, carl.id, group.id)).toBe("none");
  expect(listChannels(db, carl.id).some((c) => c.id === group.id)).toBe(false);
  expect(() => markRead(db, group.id, carl.id)).toThrow();
});

test("grantee member reads project channel, access capped by the grant", () => {
  const { db, org, owner } = setup();
  const project = gitProject(db, org);
  const other = createOrg(db, {
    name: "Other",
    slug: "other",
    ownerUserId: "u2",
    ownerName: "Zed",
    ownerHandle: "zed",
  });
  const zed = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(other.id);
  const channel = listChannels(db, owner.id).find((c) => c.kind === "project");
  expect(channel).toBeDefined();
  expect(channelAccess(db, zed?.id as string, channel?.id as string)).toBe("none");
  grantProject(db, project.id, other.id, "read", owner.id);
  expect(channelAccess(db, zed?.id as string, channel?.id as string)).toBe("read");
  expect(listChannels(db, zed?.id as string).map((c) => c.kind)).toContain("project");
  grantProject(db, project.id, other.id, "write", owner.id);
  expect(channelAccess(db, zed?.id as string, channel?.id as string)).toBe("write");
});

test("mention of a handle without channel access is not stored", () => {
  const { db, org, owner } = setup();
  const bob = human(db, org, "bob");
  human(db, org, "carl");
  const group = createGroup(db, org, "plans", [bob.id], owner.id);
  const m = postMessage(db, {
    channelId: group.id,
    authorId: owner.id,
    body: "@bob and @carl and @nobody",
  });
  expect(m.mentions).toEqual([bob.id]);
});

test("reply to a reply and cross-channel thread roots are rejected", () => {
  const { db, org, owner } = setup();
  const ch = general(db, owner.id);
  const root = postMessage(db, { channelId: ch.id, authorId: owner.id, body: "root" });
  const reply = postMessage(db, {
    channelId: ch.id,
    authorId: owner.id,
    body: "reply",
    threadRootId: root.id,
  });
  expect(() =>
    postMessage(db, { channelId: ch.id, authorId: owner.id, body: "x", threadRootId: reply.id }),
  ).toThrow("cannot reply to a reply");
  const dm = openDm(db, owner.id, human(db, org, "bob").id);
  expect(() =>
    postMessage(db, { channelId: dm.id, authorId: owner.id, body: "x", threadRootId: root.id }),
  ).toThrow("bad thread root");
});

test("listMessages returns top level with replyCount, thread replies and pages by before", () => {
  const { db, owner } = setup();
  const ch = general(db, owner.id);
  const first = postMessage(db, { channelId: ch.id, authorId: owner.id, body: "one" });
  postMessage(db, { channelId: ch.id, authorId: owner.id, body: "r1", threadRootId: first.id });
  postMessage(db, { channelId: ch.id, authorId: owner.id, body: "r2", threadRootId: first.id });
  const second = postMessage(db, { channelId: ch.id, authorId: owner.id, body: "two" });
  const top = listMessages(db, ch.id, {});
  expect(top.map((m) => [m.body, m.replyCount])).toEqual([
    ["one", 2],
    ["two", 0],
  ]);
  expect(listMessages(db, ch.id, { threadRootId: first.id }).map((m) => m.body)).toEqual([
    "r1",
    "r2",
  ]);
  expect(listMessages(db, ch.id, { limit: 1 }).map((m) => m.id)).toEqual([second.id]);
  expect(listMessages(db, ch.id, { before: second.createdAt, limit: 5 }).length).toBeLessThan(2);
});

test("body length is enforced", () => {
  const { db, owner } = setup();
  const ch = general(db, owner.id);
  const post = (body: string) => () =>
    postMessage(db, { channelId: ch.id, authorId: owner.id, body });
  expect(post("")).toThrow();
  expect(post("x".repeat(8001))).toThrow();
  expect(post("x".repeat(8000))).not.toThrow();
});

test("onMessage carries resolved mention ids, agents included", () => {
  const { db, org, owner } = setup();
  const agent = addAgentMember(db, org, {
    agentId: "codex",
    handle: "codex",
    displayName: "Codex",
    specialties: [],
  });
  const ch = general(db, owner.id);
  const seen: ChatEvent[] = [];
  const off = onMessage((e) => seen.push(e));
  postMessage(db, { channelId: ch.id, authorId: owner.id, body: "@codex fix it, cc @ghost" });
  off();
  postMessage(db, { channelId: ch.id, authorId: owner.id, body: "after unsubscribe" });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.mentions).toEqual([agent.id]);
  expect(seen[0]?.channel.id).toBe(ch.id);
});

test("unread counts ignore own messages and reset on markRead", () => {
  const { db, org, owner } = setup();
  const bob = human(db, org, "bob");
  const ch = general(db, owner.id);
  postMessage(db, { channelId: ch.id, authorId: owner.id, body: "a" });
  postMessage(db, { channelId: ch.id, authorId: bob.id, body: "b" });
  expect(general(db, bob.id).unread).toBe(1);
  expect(general(db, owner.id).unread).toBe(1);
  markRead(db, ch.id, bob.id);
  expect(general(db, bob.id).unread).toBe(0);
});

test("task numbers link to tasks of the channel's org through the real board table", () => {
  const { db, org, owner } = setup();
  const ch = general(db, owner.id);
  expect(postMessage(db, { channelId: ch.id, authorId: owner.id, body: "see #1" }).taskIds).toEqual(
    [],
  );
  const mine = createTask(db, {
    projectId: createProject(db, { orgId: org, key: "web", name: "Web" }).id,
    title: "mine",
    createdBy: owner.id,
  });
  const other = createOrg(db, {
    name: "Other",
    slug: "other",
    ownerUserId: "u2",
    ownerName: "Other",
    ownerHandle: "other",
  });
  // Task numbers restart in every org, so #1 exists in both and only ours may be linked.
  createTask(db, {
    projectId: createProject(db, { orgId: other.id, key: "o", name: "O" }).id,
    title: "theirs",
    createdBy: "x",
  });
  const m = postMessage(db, { channelId: ch.id, authorId: owner.id, body: "see #1 and #9" });
  expect(m.taskIds).toEqual([mine.id]);
  expect(listMessages(db, ch.id, {}).at(-1)?.taskIds).toEqual([mine.id]);
});

test("a throwing listener does not fail a committed message or starve later listeners", () => {
  const { db, owner } = setup();
  const seen: string[] = [];
  const off = [
    onMessage(() => {
      throw new Error("boom");
    }),
    onMessage((e) => seen.push(e.message.body)),
  ];
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const posted = postMessage(db, {
    channelId: general(db, owner.id).id,
    authorId: owner.id,
    body: "hi",
  });
  expect(quiet).toHaveBeenCalled();
  quiet.mockRestore();
  for (const stop of off) stop();
  expect(seen).toEqual(["hi"]);
  expect(listMessages(db, posted.channelId, {})).toHaveLength(1);
});

test("ensureTeamChannel is idempotent and named after the team", () => {
  const { db, org, owner } = setup();
  const team = createTeam(db, org, "Design");
  const a = ensureTeamChannel(db, team.id);
  expect(ensureTeamChannel(db, team.id).id).toBe(a.id);
  expect(a.name).toBe("Design");
  expect(channelAccess(db, owner.id, a.id)).toBe("write");
  expect(() => ensureTeamChannel(db, "missing")).toThrow(ChatError);
});
