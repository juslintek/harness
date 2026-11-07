import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { createApp } from "../../http";
import { seedMember } from "../../test-support/bridge-kit";
import { createSession } from "../auth/api";
import { createGroup, listChannels, openDm, postMessage, wireChat } from "../chat/api";
import { type ActionRequest, checkAction, decideApproval, listApprovals } from "../guard/api";
import { addAgentMember, addHumanMember, getMember, getOrg } from "../orgs/api";
import { setPolicy } from "../policies/api";
import { addTarget, startNotify } from "./api";
import { type FakeNotifier, fakeNotifier } from "./fake-notifier";

interface World {
  db: Database;
  push: FakeNotifier;
  stop: () => Promise<void>;
  orgA: string;
  alice: string;
  admin: string;
  plain: string;
  viewer: string;
  agent: string;
  bob: string;
  root: string;
  run: { id: string; prompt: string; scope: { root: string; home: string; defaultBranch: string } };
}

function world(): World {
  const db = openDb(":memory:");
  migrate(db, migrations);
  wireChat(db);
  const alice = seedMember(db, "alice");
  const orgA = alice.orgId;
  const human = (handle: string, role: "admin" | "member" | "viewer"): string => {
    const userId = `u-${handle}`;
    db.query(
      "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(userId, `${handle}@example.test`, handle, Date.now());
    return addHumanMember(db, orgA, userId, handle, handle, role).id;
  };
  const admin = human("amy", "admin");
  const plain = human("pat", "member");
  const viewer = human("vic", "viewer");
  const agent = addAgentMember(db, orgA, {
    agentId: "a",
    handle: "bot",
    displayName: "bot",
    specialties: [],
  }).id;
  const bob = seedMember(db, "bob").memberId;
  // The instance admin sits in a different org, so the fallback to their own seat is exercised.
  const root = seedMember(db, "root");
  db.query("UPDATE users SET instance_admin = 1 WHERE id = ?").run(root.userId);
  const push = fakeNotifier("push");
  const stop = startNotify(db, {
    home: "/nonexistent",
    origin: "https://h.test",
    adapters: { push },
    backoffMs: [1],
  });
  for (const id of [alice.memberId, admin, plain, viewer, bob, root.memberId]) {
    addTarget(db, id, "push", { endpoint: `https://push.test/${id}`, p256dh: "k", auth: "a" });
  }
  const runId = Bun.randomUUIDv7();
  db.run(
    "INSERT INTO runs (id, member_id, agent_id, repo, prompt, state, created_at) VALUES (?, ?, 'a', '/r', 'p', 'running', 1)",
    [runId, agent],
  );
  const scope = { root: "/work/tree", home: "/home/u", defaultBranch: "main" };
  return {
    db,
    push,
    stop,
    orgA,
    alice: alice.memberId,
    admin,
    plain,
    viewer,
    agent,
    bob,
    root: root.memberId,
    run: { id: runId, prompt: "p", scope },
  };
}

const exec = (command: string): ActionRequest => ({ kind: "execute", command, paths: [] });
function strict(w: World): void {
  setPolicy(w.db, { layer: "org", targetId: w.orgA, key: "autonomy", value: "strict", setBy: "t" });
}

const who = (w: World, kind: string): string[] =>
  w.push.calls
    .filter((c) => c.n.kind === kind)
    .map((c) => c.target.memberId)
    .sort();

test("a pending approval reaches the instance admin and org A owner and admin only", async () => {
  const w = world();
  strict(w);
  const outcome = checkAction(w.db, w.run, exec("touch x"), { approvalTimeoutMs: 10_000 });
  for (let i = 0; i < 200 && listApprovals(w.db, "pending").length === 0; i++) await Bun.sleep(10);
  const [approval] = listApprovals(w.db, "pending");
  decideApproval(w.db, approval?.id as string, "deny", "t");
  await outcome;
  await w.stop();
  expect(who(w, "approval_requested")).toEqual([w.alice, w.admin, w.root].sort());
  const sent = w.push.calls[0]?.n;
  expect(sent).toMatchObject({
    title: "Approval needed",
    path: `/#/approvals/${approval?.id}`,
    tag: `approval:${approval?.id}`,
    orgId: w.orgA,
  });
  expect(sent?.body).toContain("touch x");
  // The resolve fires the listener again; it must not send a second round.
  expect(w.push.calls).toHaveLength(3);
});

test("200 approvals in a minute stay under the per-member send cap", async () => {
  const w = world();
  strict(w);
  const checks = Array.from({ length: 200 }, (_, i) =>
    checkAction(w.db, w.run, exec(`touch f${i}`), { approvalTimeoutMs: 50 }),
  );
  await Promise.all(checks);
  await w.stop();
  const toAlice = w.push.calls.filter((c) => c.target.memberId === w.alice);
  expect(toAlice.length).toBeGreaterThan(0);
  expect(toAlice.length).toBeLessThanOrEqual(30);
  const dropped = w.db.query("SELECT 1 FROM notify_log WHERE status = 'dropped'").all();
  expect(dropped.length).toBeGreaterThan(0);
});

function orgChannel(w: World, memberId: string): string {
  return listChannels(w.db, memberId).find((c) => c.kind === "org")?.id as string;
}

async function linkedMessages(w: World, channelId: string): Promise<unknown> {
  const call = w.push.calls[0];
  expect(call?.n.path).toBe(`/#/o/${getOrg(w.db, w.orgA)?.slug}/chat/${channelId}`);
  const parts = new URL(call?.n.path as string, "http://localhost:4100").hash.slice(2).split("/");
  expect(parts[3]).toBe(channelId);
  const member = getMember(w.db, call?.target.memberId as string);
  const { token } = createSession(w.db, member?.userId as string, "passkey", null);
  const app = createApp({
    db: w.db,
    home: "/unused",
    port: 4100,
    rp: { id: "localhost", name: "Harness", origin: "http://localhost:4100" },
    instanceId: "i",
    version: "1",
  });
  const response = await app.request(`/api/channels/${parts[3]}/messages`, {
    headers: { host: "localhost:4100", cookie: `harness_session=${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("a mention notifies the human mentioned, never the author, never an agent", async () => {
  const w = world();
  const channelId = orgChannel(w, w.alice);
  const handle = (id: string): string => getMember(w.db, id)?.handle as string;
  postMessage(w.db, {
    channelId,
    authorId: w.alice,
    body: `hi @${handle(w.plain)} @${handle(w.alice)} @${handle(w.agent)}`,
  });
  await w.stop();
  expect(who(w, "mention")).toEqual([w.plain]);
  expect(w.push.calls[0]?.n.title).toContain("alice mentioned you");
  expect(w.push.calls).toHaveLength(1);
});

test("a dm notifies the other human, and nobody when the other side is an agent", async () => {
  const w = world();
  const channelId = openDm(w.db, w.alice, w.admin).id;
  const message = postMessage(w.db, {
    channelId,
    authorId: w.alice,
    body: "ping",
  });
  postMessage(w.db, {
    channelId: openDm(w.db, w.alice, w.agent).id,
    authorId: w.alice,
    body: "ping bot",
  });
  await w.stop();
  expect(who(w, "dm")).toEqual([w.admin]);
  expect(w.push.calls).toHaveLength(1);
  expect(await linkedMessages(w, channelId)).toMatchObject([{ id: message.id, body: "ping" }]);
});

test("a group mention links its recipient to the channel containing the message", async () => {
  const w = world();
  const channel = createGroup(w.db, w.orgA, "Planning", [w.plain], w.alice);
  const message = postMessage(w.db, {
    channelId: channel.id,
    authorId: w.alice,
    body: `hello @${getMember(w.db, w.plain)?.handle}`,
  });
  await w.stop();
  expect(who(w, "mention")).toEqual([w.plain]);
  expect(await linkedMessages(w, channel.id)).toMatchObject([{ id: message.id }]);
});

test("a chat secret crossing the notification body limit is redacted before clipping", async () => {
  const w = world();
  postMessage(w.db, {
    channelId: openDm(w.db, w.alice, w.admin).id,
    authorId: w.alice,
    body: `${"x".repeat(194)} ghp_${"a".repeat(36)} trailing text`,
  });
  await w.stop();
  expect(w.push.calls[0]?.n.body).not.toContain("ghp_");
});

test("a dm that also mentions the other person sends one notification", async () => {
  const w = world();
  const handle = getMember(w.db, w.admin)?.handle as string;
  postMessage(w.db, {
    channelId: openDm(w.db, w.alice, w.admin).id,
    authorId: w.alice,
    body: `@${handle} look`,
  });
  await w.stop();
  expect(w.push.calls.map((c) => c.n.kind)).toEqual(["dm"]);
});

test("after stop, events notify nobody", async () => {
  const w = world();
  await w.stop();
  postMessage(w.db, {
    channelId: openDm(w.db, w.alice, w.admin).id,
    authorId: w.alice,
    body: "late",
  });
  expect(w.push.calls).toHaveLength(0);
});
