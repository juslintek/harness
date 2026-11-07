// The Phase 5 gate's mocks, notification targets and the assertions on what each channel received.
import { setSecret } from "../src/server/features/agents/api";
import {
  newReceiver,
  type PushStub,
  type Receiver,
  startPushStub,
} from "../src/server/test-support/push-stub";
import { type SlackMock, startSlackMock } from "../src/server/test-support/slack-mock";
import { type SmtpFake, startSmtpFake } from "../src/server/test-support/smtp-fake";
import { startStub, stopStubs } from "../src/server/test-support/stub-server";
import { startTelegramMock, type TelegramMock } from "../src/server/test-support/telegram-mock";
import {
  approvalPath,
  decodePush,
  type Instance,
  type Report,
  type Session,
  signIn,
  stepUp,
  waitFor,
  webhookProblem,
} from "./gate-5-kit";

export interface Mocks {
  push: PushStub;
  receiver: Receiver;
  smtp: SmtpFake;
  hook: { url: string; calls: { headers: Headers; body: string }[] };
  slack: SlackMock;
  telegram: TelegramMock;
  stop: () => Promise<void>;
}

const ENV_KEYS = ["NODE_ENV", "SLACK_API_URL", "TELEGRAM_API_URL"] as const;
const SLACK_USER = "U0GATE5";
const TELEGRAM_CHAT = "5550001";
const ADMIN_EMAIL = "admin@gate5.test";

// The webhook and push adapters accept plain http on loopback only under NODE_ENV=test, and the
// Slack and Telegram clients read their base url from the environment. Both are set for this
// process only and put back on stop.
export async function startMocks(): Promise<Mocks> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const slack = startSlackMock();
  const telegram = startTelegramMock();
  process.env.NODE_ENV = "test";
  process.env.SLACK_API_URL = slack.url;
  process.env.TELEGRAM_API_URL = telegram.url;
  const hook: Mocks["hook"] = { url: "", calls: [] };
  const stub = await startStub(async (req) => {
    hook.calls.push({ headers: req.headers, body: await req.text() });
    return new Response("ok");
  });
  hook.url = `${stub.url}/hook`;
  const smtp = await startSmtpFake();
  return {
    push: await startPushStub(),
    receiver: newReceiver(),
    smtp,
    hook,
    slack,
    telegram,
    stop: async () => {
      smtp.stop();
      await Promise.all([slack.stop(), telegram.stop(), stopStubs()]);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export interface World {
  inst: Instance;
  mocks: Mocks;
  admin: Session;
  orgId: string;
  adminMemberId: string;
  repo: string;
  report: Report;
  webhookSecret: string;
}

async function send(
  w: Pick<World, "inst" | "admin">,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return w.inst.client.call(method, path, { cookie: w.admin.cookie, body });
}

async function mustOk(res: Promise<Response>, what: string): Promise<Record<string, string>> {
  const done = await res;
  if (!done.ok) throw new Error(`${what}: ${done.status} ${await done.text()}`);
  return (await done.json()) as Record<string, string>;
}

// Every channel is configured the way the account page and settings would, through the HTTP API
// with a step-up session. Slack and Telegram have no settings route yet, so their bot tokens go
// straight into the secrets file the adapters read.
export async function configureTargets(
  w: Pick<World, "inst" | "admin" | "mocks">,
): Promise<string> {
  const { mocks } = w;
  await stepUp(w.inst, w.admin.cookie);
  const smtp = {
    host: "127.0.0.1",
    port: mocks.smtp.port,
    security: "none",
    from: "harness@gate5.test",
  };
  await mustOk(send(w, "PUT", "/api/notify/email/config", smtp), "smtp config");
  const keys = { p256dh: mocks.receiver.p256dh, auth: mocks.receiver.auth };
  await mustOk(
    send(w, "POST", "/api/notify/push/subscribe", { endpoint: mocks.push.url, keys }),
    "push",
  );
  const add = (channel: string, value: Record<string, string>): Promise<Record<string, string>> =>
    mustOk(send(w, "POST", "/api/notify/targets", { channel, value }), channel);
  await add("email", { address: ADMIN_EMAIL });
  await add("slack", { userId: SLACK_USER });
  await add("telegram", { chatId: TELEGRAM_CHAT });
  setSecret("slack.bot_token", mocks.slack.botToken, w.inst.home);
  setSecret("telegram.bot_token", mocks.telegram.token, w.inst.home);
  const hook = await mustOk(
    send(w, "POST", "/api/notify/targets", { channel: "webhook", url: mocks.hook.url }),
    "webhook",
  );
  for (const channel of ["slack", "telegram", "webhook"]) {
    const pref = { channel, kind: "approval_requested", enabled: true };
    await mustOk(send(w, "PUT", "/api/notify/prefs", pref), `${channel} pref`);
  }
  return hook.secret ?? "";
}

async function eventually<T>(
  read: () => T | undefined | false | null,
  ms = 20_000,
): Promise<T | null> {
  try {
    return await waitFor("a delivery", read, ms);
  } catch {
    return null;
  }
}

function checkPush(w: World, id: string): Promise<void> {
  const { origin } = w.inst;
  return eventually(() =>
    w.mocks.push.requests
      .map((r) => decodePush(w.mocks.receiver, r.body))
      .find((p) => p?.tag === `approval:${id}`),
  ).then((payload) => {
    w.report.check(1, payload !== null, "push stub got an encrypted push for the approval");
    w.report.check(
      1,
      payload?.url === `${origin}${approvalPath(id)}`,
      `decrypted push url is the approval deep link (${payload?.url ?? "none"})`,
    );
  });
}

async function checkMail(w: World, id: string): Promise<void> {
  const link = `${w.inst.origin}${approvalPath(id)}`;
  const mail = await eventually(() => w.mocks.smtp.mails.find((m) => m.data.includes(link)));
  w.report.check(2, mail !== null, "fake SMTP got a mail carrying the approval link");
  w.report.check(
    2,
    mail?.to.some((t) => t.includes(ADMIN_EMAIL)) === true,
    "mail went to the admin",
  );
}

async function checkWebhook(w: World, id: string): Promise<void> {
  const call = await eventually(() => w.mocks.hook.calls.find((c) => c.body.includes(id)));
  w.report.check(3, call !== null, "webhook receiver got the approval event");
  if (call === null) return;
  const problem = webhookProblem(w.webhookSecret, call.headers, call.body, Date.now(), 60);
  w.report.check(
    3,
    problem === null,
    `webhook signature and timestamp verify (${problem ?? "ok"})`,
  );
}

async function checkChat(w: World, id: string): Promise<void> {
  const link = `${w.inst.origin}${approvalPath(id)}`;
  const slack = await eventually(() =>
    w.mocks.slack.posts.find(
      (p) => p.body.channel === SLACK_USER && String(p.body.text).includes(link),
    ),
  );
  w.report.check(4, slack !== null, "mock Slack got the DM with the link");
  const telegram = await eventually(() =>
    w.mocks.telegram.sent.find((m) => String(m.chat_id) === TELEGRAM_CHAT && m.text.includes(link)),
  );
  w.report.check(4, telegram !== null, "mock Telegram got the DM with the link");
}

// Assertions 1 to 4: one approval fans out to every configured channel.
export async function checkChannels(w: World, approvalId: string): Promise<void> {
  await Promise.all([
    checkPush(w, approvalId),
    checkMail(w, approvalId),
    checkWebhook(w, approvalId),
    checkChat(w, approvalId),
  ]);
}

interface Decided {
  status: string;
  decided_by: string | null;
  decided_at: number | null;
}

// Assertion 5: the approval is read and decided through the HTTP API by a session that got its
// step-up from a passkey assertion, and the same call without step-up is refused first.
export async function decideOverHttp(w: World, approvalId: string): Promise<void> {
  const { inst, report } = w;
  const cookie = await signIn(inst);
  const path = `/api/approvals/${approvalId}`;
  const read = await inst.client.call("GET", path, { cookie });
  const view = (await read.json()) as { id?: string; status?: string };
  report.check(
    5,
    read.status === 200 && view.id === approvalId && view.status === "pending",
    "GET approval shows it pending",
  );
  const decision = { body: { decision: "approve" }, cookie };
  const refused = await inst.client.call("POST", path, decision);
  const reason = ((await refused.json()) as { error?: string }).error;
  report.check(
    5,
    refused.status === 403 && reason === "step_up_required",
    "decision without step-up is refused with 403",
  );
  await stepUp(inst, cookie);
  const done = await inst.client.call("POST", path, decision);
  report.check(5, done.status === 200, `decision with fresh step-up is accepted (${done.status})`);
  const row = inst.db
    .query<Decided, [string]>("SELECT status, decided_by, decided_at FROM approvals WHERE id = ?")
    .get(approvalId);
  report.check(
    5,
    row?.status === "approved" && row.decided_by === `user:${w.admin.userId}`,
    "approval is stored as approved by the admin user",
  );
  const proof = inst.db
    .query("SELECT 1 FROM sessions WHERE user_id = ? AND method = 'passkey' AND step_up_at <= ?")
    .get(w.admin.userId, row?.decided_at ?? 0);
  report.check(5, proof !== null, "the deciding session is a passkey session with step-up");
}
