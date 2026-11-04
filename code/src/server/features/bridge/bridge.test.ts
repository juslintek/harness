import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { withActor } from "../../test-support/app-kit";
import { type SlackMock, startSlackMock, until } from "../../test-support/slack-mock";
import { setSecret } from "../agents/api";
import type { AuthEnv } from "../auth/api";
import { listChannels, postMessage, wireChat } from "../chat/api";
import { createOrg, memberForUser } from "../orgs/api";
import { startBridges } from "./api";
import { createEcho } from "./inbound";
import { bridgesOfChannel, linkBridge, linkExternalUser } from "./repo";
import { bridgeRoutes } from "./routes";

interface Seed {
  userId: string;
  memberId: string;
  orgId: string;
}

function seedMember(db: Database, handle: string): Seed {
  const userId = `u-${handle}`;
  db.query(
    "INSERT INTO users (id, email, name, instance_admin, created_at) VALUES (?, ?, ?, 0, ?)",
  ).run(userId, `${handle}@example.test`, handle, Date.now());
  const org = createOrg(db, {
    name: handle,
    slug: handle,
    ownerUserId: userId,
    ownerName: handle,
    ownerHandle: handle,
  });
  const member = memberForUser(db, org.id, userId);
  if (!member) throw new Error("owner member missing");
  return { userId, memberId: member.id, orgId: org.id };
}

interface World {
  db: Database;
  home: string;
  ada: Seed;
  bob: Seed;
  adaChannel: string;
  bobChannel: string;
}

let mock: SlackMock;
let stop: (() => Promise<void>) | null = null;
const before = process.env.SLACK_API_URL;

beforeEach(() => {
  mock = startSlackMock();
  process.env.SLACK_API_URL = mock.url;
});

afterEach(async () => {
  await stop?.();
  stop = null;
  if (before === undefined) delete process.env.SLACK_API_URL;
  else process.env.SLACK_API_URL = before;
  await mock.stop();
});

function world(): World {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ada = seedMember(db, "ada");
  const bob = seedMember(db, "bob");
  wireChat(db);
  const orgChannel = (memberId: string): string => {
    const found = listChannels(db, memberId).find((c) => c.kind === "org");
    if (!found) throw new Error("no org channel");
    return found.id;
  };
  const home = mkdtempSync(join(tmpdir(), "bridge-"));
  setSecret("slack.bot_token", mock.botToken, home);
  setSecret("slack.app_token", mock.appToken, home);
  return {
    db,
    home,
    ada,
    bob,
    adaChannel: orgChannel(ada.memberId),
    bobChannel: orgChannel(bob.memberId),
  };
}

const bodies = (db: Database): string[] =>
  db
    .query<{ body: string }, []>("SELECT body FROM messages ORDER BY created_at, rowid")
    .all()
    .map((r) => r.body);

const slackMessage = (
  user: string,
  text: string,
  extra: Record<string, unknown> = {},
): unknown => ({
  authorizations: [{ user_id: "UBOT" }],
  event: { type: "message", user, channel: "C1", text, ...extra },
});

async function boot(w: World): Promise<void> {
  linkBridge(w.db, {
    orgId: w.ada.orgId,
    channelId: w.adaChannel,
    kind: "slack",
    externalId: "C1",
  });
  linkExternalUser(w.db, "slack", "UADA", w.ada.memberId);
  stop = startBridges(w.db, { home: w.home, origin: "https://h.test" });
  await until(() => mock.sockets() === 1);
}

test("a linked user's Slack message becomes a harness message by that member and is not sent back out", async () => {
  const w = world();
  await boot(w);
  mock.push(slackMessage("UADA", "from slack"));
  await until(() => bodies(w.db).includes("from slack"));
  const row = w.db
    .query<{ author_id: string }, [string]>("SELECT author_id FROM messages WHERE body = ?")
    .get("from slack");
  expect(row?.author_id).toBe(w.ada.memberId);
  await Bun.sleep(50);
  expect(mock.posts).toHaveLength(0);
});

test("unlinked users, bot posts and unlinked channels leave no trace", async () => {
  const w = world();
  await boot(w);
  const sent = bodies(w.db).length;
  mock.push(slackMessage("USTRANGER", "who am i"));
  mock.push(slackMessage("UBOT", "my own echo"));
  mock.push(slackMessage("UADA", "bot flagged", { bot_id: "B1" }));
  mock.push(slackMessage("UADA", "elsewhere", { channel: "C404" }));
  await until(() => mock.acks.length === 4);
  await Bun.sleep(50);
  expect(bodies(w.db)).toHaveLength(sent);
  expect(w.db.query("SELECT 1 FROM notify_log").all()).toHaveLength(0);
});

test("a harness message in a bridged channel is posted to Slack once and not echoed back", async () => {
  const w = world();
  await boot(w);
  postMessage(w.db, { channelId: w.adaChannel, authorId: w.ada.memberId, body: "from harness" });
  await until(() => mock.posts.length === 1);
  expect(mock.posts[0]?.body).toEqual({ channel: "C1", text: "*ada*: from harness" });
  mock.push(slackMessage("UBOT", "*ada*: from harness", { bot_id: "B1" }));
  await until(() => mock.acks.length === 1);
  await Bun.sleep(50);
  expect(mock.posts).toHaveLength(1);
  expect(bodies(w.db).filter((b) => b === "*ada*: from harness")).toHaveLength(0);
});

test("a channel that is not bridged posts nothing", async () => {
  const w = world();
  await boot(w);
  postMessage(w.db, { channelId: w.bobChannel, authorId: w.bob.memberId, body: "elsewhere" });
  await Bun.sleep(50);
  expect(mock.posts).toHaveLength(0);
});

test("a Slack user linked in org A cannot post into an org B channel bridged to Slack", async () => {
  const w = world();
  linkBridge(w.db, {
    orgId: w.bob.orgId,
    channelId: w.bobChannel,
    kind: "slack",
    externalId: "C1",
  });
  linkExternalUser(w.db, "slack", "UADA", w.ada.memberId);
  stop = startBridges(w.db, { home: w.home, origin: "https://h.test" });
  await until(() => mock.sockets() === 1);
  mock.push(slackMessage("UADA", "cross org"));
  await until(() => mock.acks.length === 1);
  await Bun.sleep(50);
  expect(bodies(w.db)).not.toContain("cross org");
});

test("no Socket Mode connection without both tokens", async () => {
  const w = world();
  setSecret("slack.app_token", "", w.home);
  stop = startBridges(w.db, { home: w.home, origin: "https://h.test" });
  await Bun.sleep(50);
  expect(mock.opens).toHaveLength(0);
});

test("the echo set stays at 1000 ids, dropping the oldest", () => {
  const echo = createEcho();
  for (let i = 0; i < 1005; i++) echo.mark(`m${i}`);
  expect(echo.has("m0")).toBe(false);
  expect(echo.has("m4")).toBe(false);
  expect(echo.has("m5")).toBe(true);
  expect(echo.has("m1004")).toBe(true);
});

function api(w: World, as: { userId: string }, stepUp = true): Hono<AuthEnv> {
  return withActor(bridgeRoutes(w.db), {
    userId: as.userId,
    instanceAdmin: false,
    stepUpAt: stepUp ? Date.now() : null,
  });
}

const call = (
  app: Hono<AuthEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

test("an org admin links, lists and unlinks a channel of their own org", async () => {
  const w = world();
  const app = api(w, w.ada);
  const made = await call(app, "POST", "/links", {
    channelId: w.adaChannel,
    kind: "slack",
    externalId: "C77",
  });
  expect(made.status).toBe(201);
  const { id } = (await made.json()) as { id: string };
  const list = (await (await call(app, "GET", "/links?org=ada")).json()) as { id: string }[];
  expect(list.map((l) => l.id)).toEqual([id]);
  const dupe = await call(app, "POST", "/links", {
    channelId: w.adaChannel,
    kind: "slack",
    externalId: "C77",
  });
  expect(dupe.status).toBe(409);
  expect((await call(app, "DELETE", `/links/${id}`)).status).toBe(200);
  expect(bridgesOfChannel(w.db, w.adaChannel)).toHaveLength(0);
});

test("an admin of org A cannot link, list or unlink anything of org B", async () => {
  const w = world();
  const app = api(w, w.ada);
  const forged = await call(app, "POST", "/links", {
    channelId: w.bobChannel,
    kind: "slack",
    externalId: "C9",
  });
  expect(forged.status).toBe(403);
  expect(bridgesOfChannel(w.db, w.bobChannel)).toHaveLength(0);
  const bobLink = linkBridge(w.db, {
    orgId: w.bob.orgId,
    channelId: w.bobChannel,
    kind: "slack",
    externalId: "C8",
  });
  expect((await call(app, "GET", "/links?org=bob")).status).toBe(404);
  expect((await call(app, "DELETE", `/links/${bobLink}`)).status).toBe(404);
  expect(bridgesOfChannel(w.db, w.bobChannel)).toHaveLength(1);
});

test("creating a link needs a fresh step-up", async () => {
  const w = world();
  const res = await call(api(w, w.ada, false), "POST", "/links", {
    channelId: w.adaChannel,
    kind: "slack",
    externalId: "C5",
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "step_up_required" });
});

test("a member links their own Slack id, and relinking replaces it", async () => {
  const w = world();
  const res = await call(api(w, w.ada), "POST", "/users", {
    kind: "slack",
    externalUserId: "U42",
  });
  expect(res.status).toBe(200);
  const owner = (id: string): string | undefined =>
    w.db
      .query<{ member_id: string }, [string]>(
        "SELECT member_id FROM bridge_users WHERE external_user_id = ?",
      )
      .get(id)?.member_id;
  expect(owner("U42")).toBe(w.ada.memberId);
  await call(api(w, w.bob), "POST", "/users", { kind: "slack", externalUserId: "U42" });
  expect(owner("U42")).toBe(w.bob.memberId);
});
