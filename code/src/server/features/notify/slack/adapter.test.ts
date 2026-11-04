import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { type SlackMock, startSlackMock } from "../../../test-support/slack-mock";
import { setSecret } from "../../agents/api";
import { slackNotifier } from "./adapter";

const target: Target = { id: "t1", channel: "slack", memberId: "m1", value: { userId: "U1" } };
const note: Notification = {
  kind: "dm",
  orgId: "o1",
  title: "New DM",
  body: "hello",
  path: "/#/chat/x",
  tag: "x",
};

let mock: SlackMock;
let home: string;
const before = process.env.SLACK_API_URL;

beforeEach(() => {
  mock = startSlackMock();
  home = mkdtempSync(join(tmpdir(), "slack-adapter-"));
  process.env.SLACK_API_URL = mock.url;
});

afterEach(async () => {
  if (before === undefined) delete process.env.SLACK_API_URL;
  else process.env.SLACK_API_URL = before;
  await mock.stop();
});

test("posts a DM by user id with the bot token in the header only", async () => {
  setSecret("slack.bot_token", mock.botToken, home);
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(res).toEqual({ ok: true });
  expect(mock.posts).toHaveLength(1);
  expect(mock.posts[0]?.auth).toBe(`Bearer ${mock.botToken}`);
  expect(mock.posts[0]?.body.channel).toBe("U1");
  const text = String(mock.posts[0]?.body.text);
  expect(text).toContain("New DM");
  expect(text).toContain("https://h.test/#/chat/x");
  expect(JSON.stringify(mock.posts[0]?.body)).not.toContain(mock.botToken);
});

test("not configured without a bot token", async () => {
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(res).toEqual({ ok: false, retry: false, reason: "not configured" });
  expect(mock.posts).toHaveLength(0);
});

test("ratelimited with Retry-After is retryable", async () => {
  setSecret("slack.bot_token", mock.botToken, home);
  mock.postReplies.push({
    status: 429,
    headers: { "Retry-After": "3" },
    json: { ok: false, error: "ratelimited" },
  });
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(res).toMatchObject({ ok: false, retry: true });
});

test("invalid_auth is permanent and the failure text never holds the token", async () => {
  setSecret("slack.bot_token", "xoxb-wrong-secret", home);
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(res).toMatchObject({ ok: false, retry: false, reason: "slack: invalid_auth" });
  expect(JSON.stringify(res)).not.toContain("xoxb-wrong-secret");
});

test("a Slack error that echoes the token is scrubbed", async () => {
  setSecret("slack.bot_token", mock.botToken, home);
  mock.postReplies.push({ json: { ok: false, error: `bad ${mock.botToken}` } });
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(JSON.stringify(res)).not.toContain(mock.botToken);
  expect(JSON.stringify(res)).toContain("***");
});

test("an unreachable Slack is retryable", async () => {
  setSecret("slack.bot_token", mock.botToken, home);
  process.env.SLACK_API_URL = "http://127.0.0.1:1";
  const res = await slackNotifier(home).deliver(target, note, "https://h.test");
  expect(res).toMatchObject({ ok: false, retry: true });
});
