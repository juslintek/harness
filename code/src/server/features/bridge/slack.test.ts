import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { seedMember } from "../../test-support/bridge-kit";
import { type SlackMock, startSlackMock, until } from "../../test-support/slack-mock";
import { setSecret } from "../agents/api";
import type { InboundMessage } from "./inbound";
import { createLinkCodes } from "./link-codes";
import { linkExternalUser, memberOfExternal } from "./repo";
import { startSlackSocket } from "./slack";

let mock: SlackMock;
let home: string;
let stop: (() => Promise<void>) | null = null;
const before = process.env.SLACK_API_URL;

beforeEach(() => {
  mock = startSlackMock();
  home = mkdtempSync(join(tmpdir(), "slack-socket-"));
  setSecret("slack.app_token", mock.appToken, home);
  process.env.SLACK_API_URL = mock.url;
});

afterEach(async () => {
  await stop?.();
  stop = null;
  if (before === undefined) delete process.env.SLACK_API_URL;
  else process.env.SLACK_API_URL = before;
  await mock.stop();
});

const message = (over: Record<string, unknown> = {}): unknown => ({
  authorizations: [{ user_id: "UBOT" }],
  event: { type: "message", user: "U1", channel: "C1", text: "hi", ...over },
});

test("acks every envelope and passes plain human messages on", async () => {
  const got: InboundMessage[] = [];
  stop = startSlackSocket({ home, onMessage: (m) => got.push(m) });
  await until(() => mock.sockets() === 1);
  mock.push(message(), "e1");
  mock.push(message({ subtype: "message_changed" }), "e2");
  mock.push(message({ bot_id: "B1" }), "e3");
  mock.push(message({ user: "UBOT" }), "e4");
  mock.push(message({ text: undefined }), "e5");
  await until(() => mock.acks.length === 5);
  expect(mock.acks).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  expect(got).toEqual([{ kind: "slack", externalChannel: "C1", externalUser: "U1", text: "hi" }]);
  expect(mock.opens[0]?.auth).toBe(`Bearer ${mock.appToken}`);
});

test("only a Slack slash command in a one-to-one DM can redeem a link code", async () => {
  setSecret("slack.bot_token", mock.botToken, home);
  const db = openDb(":memory:");
  migrate(db, migrations);
  const member = seedMember(db, "slack-link");
  const codes = createLinkCodes(() => 1_000_000);
  const { code } = codes.issue("slack", member.memberId);
  stop = startSlackSocket({
    home,
    onMessage: () => {},
    onLink: (userId, value) => {
      const memberId = codes.redeem("slack", value);
      return memberId ? linkExternalUser(db, "slack", userId, memberId) : false;
    },
  });
  await until(() => mock.sockets() === 1);
  mock.push(
    { command: "/link", text: code, user_id: "U1", channel_id: "G1" },
    "group-code",
    "slash_commands",
  );
  mock.push(
    { command: "/link", text: code, user_id: "U1", channel_id: "D1" },
    "private-code",
    "slash_commands",
  );
  await until(() => mock.acks.length === 2 && mock.posts.length === 1);
  expect(memberOfExternal(db, "slack", "U1")).toBe(member.memberId);
  expect(mock.posts[0]?.body).toMatchObject({ channel: "D1" });
  expect(mock.posts[0]?.body.text).toContain("Linked");
});

test("reopens the connection after a drop, then backs off 1s to 30s while opens fail", async () => {
  const waits: number[] = [];
  stop = startSlackSocket({
    home,
    onMessage: () => {},
    sleep: async (ms) => {
      waits.push(ms);
      await Bun.sleep(1);
    },
  });
  await until(() => mock.sockets() === 1);
  mock.failOpens.n = 7;
  mock.drop();
  await until(() => mock.sockets() === 1 && waits.length >= 8);
  expect(mock.opens).toHaveLength(9);
  expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
});

test("a bad app token never reaches the log or the loop's errors", async () => {
  setSecret("slack.app_token", "xapp-wrong-secret", home);
  const logged: string[] = [];
  const spy = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    stop = startSlackSocket({ home, onMessage: () => {}, sleep: () => Bun.sleep(5) });
    await until(() => mock.opens.length >= 2);
  } finally {
    console.error = spy;
  }
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.join("\n")).not.toContain("xapp-wrong-secret");
  expect(logged.join("\n")).toContain("invalid_auth");
});

test("stop closes the socket and returns promptly even mid-backoff", async () => {
  stop = startSlackSocket({ home, onMessage: () => {} });
  await until(() => mock.sockets() === 1);
  mock.drop();
  const started = Date.now();
  await stop();
  stop = null;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(mock.sockets()).toBe(0);
});

test("stop during a pending connection open does not open a late socket", async () => {
  let resolveOpen!: (connection: { url: string }) => void;
  let enteredOpen!: () => void;
  const entered = new Promise<void>((resolve) => (enteredOpen = resolve));
  const pending = new Promise<{ url: string }>((resolve) => (resolveOpen = resolve));
  stop = startSlackSocket({
    home,
    onMessage: () => {},
    openConnection: () => {
      enteredOpen();
      return pending;
    },
  });
  await entered;
  const stopping = stop();
  resolveOpen({ url: `${mock.url.replace("http", "ws")}/ws` });
  await stopping;
  stop = null;
  expect(mock.sockets()).toBe(0);
});
