import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { withActor } from "../../test-support/app-kit";
import { bodiesOf, orgChannelOf, type Seed, seedMember } from "../../test-support/bridge-kit";
import { until } from "../../test-support/slack-mock";
import { startTelegramMock, type TelegramMock } from "../../test-support/telegram-mock";
import { setSecret } from "../agents/api";
import { postMessage, wireChat } from "../chat/api";
import { listTargets } from "../notify/api";
import { startBridges } from "./api";
import { createEcho } from "./inbound";
import { createLinkCodes } from "./link-codes";
import { linkBridge, linkExternalUser, memberOfExternal } from "./repo";
import { bridgeRoutes } from "./routes";
import { startTelegramPoll } from "./telegram";

let mock: TelegramMock;
let home: string;
let db: Database;
let ada: Seed;
let channelId: string;
let stop: (() => Promise<void>) | null = null;
const before = process.env.TELEGRAM_API_URL;

beforeEach(() => {
  mock = startTelegramMock();
  home = mkdtempSync(join(tmpdir(), "telegram-bridge-"));
  setSecret("telegram.bot_token", mock.token, home);
  process.env.TELEGRAM_API_URL = mock.url;
  db = openDb(":memory:");
  migrate(db, migrations);
  ada = seedMember(db, "ada");
  wireChat(db);
  channelId = orgChannelOf(db, ada.memberId);
});

afterEach(async () => {
  await stop?.();
  stop = null;
  if (before === undefined) delete process.env.TELEGRAM_API_URL;
  else process.env.TELEGRAM_API_URL = before;
  await mock.stop();
});

const group = (from: number, text: string, chat = -100): Record<string, unknown> => ({
  message: { text, chat: { id: chat, type: "supergroup" }, from: { id: from } },
});
const privateChat = (from: number, text: string): Record<string, unknown> => ({
  message: { text, chat: { id: from, type: "private" }, from: { id: from } },
});

function boot(): void {
  linkBridge(db, { orgId: ada.orgId, channelId, kind: "telegram", externalId: "-100" });
  linkExternalUser(db, "telegram", "7", ada.memberId);
  stop = startBridges(db, { home, origin: "https://h.test" });
}

test("a linked user's group message posts as that member, once, and is not sent back out", async () => {
  boot();
  mock.enqueue(group(7, "from telegram"));
  await until(() => bodiesOf(db).includes("from telegram"));
  const row = db
    .query<{ author_id: string }, [string]>("SELECT author_id FROM messages WHERE body = ?")
    .get("from telegram");
  expect(row?.author_id).toBe(ada.memberId);
  await Bun.sleep(80);
  expect(bodiesOf(db).filter((b) => b === "from telegram")).toHaveLength(1);
  expect(mock.sent).toHaveLength(0);
});

test("unknown users, other chats and private chatter are ignored", async () => {
  boot();
  const sent = bodiesOf(db).length;
  mock.enqueue(group(8, "who am i"));
  mock.enqueue(group(7, "elsewhere", -999));
  mock.enqueue(privateChat(7, "hello bot"));
  mock.enqueue({
    message: { text: "bot", chat: { id: -100, type: "group" }, from: { id: 7, is_bot: true } },
  });
  await until(() => mock.polls.length >= 3 && mock.polls.some((p) => (p.offset ?? 0) >= 104));
  expect(bodiesOf(db)).toHaveLength(sent);
});

test("the offset advances so an update is handled once", async () => {
  boot();
  const first = mock.enqueue(group(7, "one"));
  await until(() => mock.polls.some((p) => p.offset === first + 1));
  const second = mock.enqueue(group(7, "two"));
  await until(() => mock.polls.some((p) => p.offset === second + 1));
  expect(bodiesOf(db).filter((b) => b === "one" || b === "two")).toEqual(["one", "two"]);
  expect(mock.polls[0]).toEqual({ offset: 0, timeout: 25 });
});

test("a harness message in a bridged group is sent once and not echoed", async () => {
  boot();
  postMessage(db, { channelId, authorId: ada.memberId, body: "from harness" });
  await until(() => mock.sent.length === 1);
  expect(mock.sent[0]).toEqual({ chat_id: "-100", text: "*ada*: from harness" });
  mock.enqueue({
    message: {
      text: "*ada*: from harness",
      chat: { id: -100, type: "group" },
      from: { id: 999, is_bot: true },
    },
  });
  await Bun.sleep(80);
  expect(mock.sent).toHaveLength(1);
  expect(bodiesOf(db).filter((b) => b === "*ada*: from harness")).toHaveLength(0);
});

test("/link with a valid code links the user and stores a notify target, a reused code is refused", async () => {
  const clock = 1_000_000;
  const codes = createLinkCodes(() => clock);
  stop = startTelegramPoll({ db, home, echo: createEcho(), codes });
  const { code } = codes.issue(ada.memberId);
  mock.enqueue(privateChat(55, `/link ${code}`));
  await until(() => mock.sent.length === 1);
  expect(memberOfExternal(db, "telegram", "55")).toBe(ada.memberId);
  expect(listTargets(db, ada.memberId)).toMatchObject([{ channel: "telegram", label: "55" }]);
  mock.enqueue(privateChat(56, `/link ${code}`));
  await until(() => mock.sent.length === 2);
  expect(mock.sent[1]?.text).toContain("invalid or expired");
  expect(memberOfExternal(db, "telegram", "56")).toBeNull();
});

test("an expired code is refused", async () => {
  let clock = 1_000_000;
  const codes = createLinkCodes(() => clock);
  const { code, expiresAt } = codes.issue(ada.memberId);
  expect(expiresAt - clock).toBe(10 * 60_000);
  clock = expiresAt;
  stop = startTelegramPoll({ db, home, echo: createEcho(), codes });
  mock.enqueue(privateChat(55, `/link ${code}`));
  await until(() => mock.sent.length === 1);
  expect(mock.sent[0]?.text).toContain("invalid or expired");
  expect(memberOfExternal(db, "telegram", "55")).toBeNull();
});

test("the link-code route issues an 8 char code for the signed-in member", async () => {
  const app = withActor(bridgeRoutes(db), { userId: ada.userId });
  const res = await app.request("/telegram/link-code", { method: "POST" });
  const body = (await res.json()) as { code: string; expiresAt: number };
  expect(res.status).toBe(200);
  expect(body.code).toMatch(/^[A-Z2-9]{8}$/);
  expect(body.expiresAt).toBeGreaterThan(Date.now());
});

test("polling backs off 1s up to 30s on failures and the token never reaches the log", async () => {
  const waits: number[] = [];
  const logged: string[] = [];
  const spy = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  mock.failPolls.n = 7;
  try {
    stop = startTelegramPoll({
      db,
      home,
      echo: createEcho(),
      codes: createLinkCodes(),
      sleep: async (ms) => {
        waits.push(ms);
        await Bun.sleep(1);
      },
    });
    await until(() => waits.length === 7);
  } finally {
    console.error = spy;
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  expect(logged.join("\n")).not.toContain(mock.token);
});

test("stop aborts a held poll promptly", async () => {
  boot();
  await until(() => mock.polls.length >= 1);
  const started = Date.now();
  await stop?.();
  stop = null;
  expect(Date.now() - started).toBeLessThan(1000);
});

test("no polling without a bot token", async () => {
  setSecret("telegram.bot_token", "", home);
  stop = startBridges(db, { home, origin: "https://h.test" });
  await Bun.sleep(50);
  expect(mock.polls).toHaveLength(0);
});
