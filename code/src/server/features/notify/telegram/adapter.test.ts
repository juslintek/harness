import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { startTelegramMock, type TelegramMock } from "../../../test-support/telegram-mock";
import { setSecret } from "../../agents/api";
import { telegramNotifier } from "./adapter";

const target: Target = { id: "t1", channel: "telegram", memberId: "m1", value: { chatId: "42" } };
const note: Notification = {
  kind: "dm",
  orgId: "o1",
  title: "New DM",
  body: "hello",
  path: "/#/chat/x",
  tag: "x",
};

let mock: TelegramMock;
let home: string;
const before = process.env.TELEGRAM_API_URL;

beforeEach(() => {
  mock = startTelegramMock();
  home = mkdtempSync(join(tmpdir(), "telegram-adapter-"));
  setSecret("telegram.bot_token", mock.token, home);
  process.env.TELEGRAM_API_URL = mock.url;
});

afterEach(async () => {
  if (before === undefined) delete process.env.TELEGRAM_API_URL;
  else process.env.TELEGRAM_API_URL = before;
  await mock.stop();
});

const deliver = (): ReturnType<ReturnType<typeof telegramNotifier>["deliver"]> =>
  telegramNotifier(home).deliver(target, note, "https://h.test");

test("sends a DM notification to the chat id", async () => {
  expect(await deliver()).toEqual({ ok: true });
  expect(mock.sent).toHaveLength(1);
  expect(mock.sent[0]?.chat_id).toBe("42");
  expect(mock.sent[0]?.text).toContain("New DM");
  expect(mock.sent[0]?.text).toContain("https://h.test/#/chat/x");
  expect(JSON.stringify(mock.sent[0])).not.toContain(mock.token);
});

test("not configured without a bot token", async () => {
  setSecret("telegram.bot_token", "", home);
  expect(await deliver()).toEqual({ ok: false, retry: false, reason: "not configured" });
  expect(mock.sent).toHaveLength(0);
});

test("429 with retry_after is retryable", async () => {
  mock.sendReplies.push({
    status: 429,
    json: {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 3 },
    },
  });
  expect(await deliver()).toMatchObject({ ok: false, retry: true });
});

test("403 bot blocked means the target is gone", async () => {
  mock.sendReplies.push({
    status: 403,
    json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
  });
  expect(await deliver()).toMatchObject({ ok: false, retry: false, gone: true });
});

test("other 4xx is permanent and 5xx is retryable", async () => {
  mock.sendReplies.push({ status: 400, json: { ok: false, description: "chat not found" } });
  mock.sendReplies.push({ status: 502, json: { ok: false, description: "bad gateway" } });
  expect(await deliver()).toMatchObject({ ok: false, retry: false });
  expect(await deliver()).toMatchObject({ ok: false, retry: true });
});

test("a Telegram error that echoes the token is scrubbed", async () => {
  mock.sendReplies.push({
    status: 400,
    json: { ok: false, description: `bad request /bot${mock.token}/sendMessage` },
  });
  const res = await deliver();
  expect(JSON.stringify(res)).not.toContain(mock.token);
  expect(JSON.stringify(res)).toContain("***");
});

test("a wrong token is permanent and never appears in the failure", async () => {
  setSecret("telegram.bot_token", "999:wrong-secret", home);
  const res = await deliver();
  expect(res).toMatchObject({ ok: false, retry: false });
  expect(JSON.stringify(res)).not.toContain("wrong-secret");
});

test("an unreachable Telegram is retryable and leaks no URL", async () => {
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:1";
  const res = await deliver();
  expect(res).toMatchObject({ ok: false, retry: true });
  expect(JSON.stringify(res)).not.toContain(mock.token);
});
