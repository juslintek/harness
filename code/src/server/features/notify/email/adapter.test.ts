import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { migrate, openDb } from "../../../db/db";
import { migrations } from "../../../db/migrations";
import { until } from "../../../test-support/app-kit";
import { seedMember } from "../../../test-support/bridge-kit";
import { type SmtpFake, type SmtpFakeOpts, startSmtpFake } from "../../../test-support/smtp-fake";
import { setSecret } from "../../agents/api";
import { requestEmailCode } from "../../auth/api";
import { emailCodeSender, emailNotifier } from "./adapter";
import { saveSmtpConfig } from "./config";

const PASSWORD = "hunter2-s3cret";
const target: Target = {
  id: "t1",
  channel: "email",
  memberId: "m1",
  value: { address: "ada@example.test" },
};
const note: Notification = {
  kind: "approval_requested",
  orgId: "o1",
  title: "Approve\r\nBcc: x@y.test",
  body: "run 7 wants to push",
  path: "/#/approvals/a1",
  tag: "a1",
};
let fake: SmtpFake | null = null;

afterEach(() => {
  fake?.stop();
  fake = null;
});

async function setup(opts: SmtpFakeOpts = {}): Promise<{ db: Database; home: string }> {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const home = mkdtempSync(join(tmpdir(), "harness-email-"));
  fake = await startSmtpFake(opts);
  return { db, home };
}

function configure(db: Database, home: string): void {
  saveSmtpConfig(db, {
    host: "127.0.0.1",
    port: fake?.port ?? 0,
    security: "none",
    user: "mailer",
    from: "harness@example.test",
  });
  setSecret("smtp.password", PASSWORD, home);
}

test("deliver sends a [harness] subject and the body with an absolute link", async () => {
  const { db, home } = await setup();
  configure(db, home);
  const res = await emailNotifier({ db, home }).deliver(target, note, "https://h.example.test");
  expect(res).toEqual({ ok: true });
  const got = fake?.mails[0];
  expect(got?.to).toEqual(["ada@example.test"]);
  expect(got?.data).toContain("Subject: [harness] Approve Bcc: x@y.test");
  expect(got?.data).not.toContain("\r\nBcc:");
  expect(got?.data).toContain("run 7 wants to push\r\n\r\nhttps://h.example.test/#/approvals/a1");
  expect(fake?.auths).toEqual([`\0mailer\0${PASSWORD}`]);
});

test("deliver without SMTP config is a permanent failure", async () => {
  const { db, home } = await setup();
  const res = await emailNotifier({ db, home }).deliver(target, note, "https://h");
  expect(res).toEqual({ ok: false, retry: false, reason: "not configured" });
});

test("a 5xx is not retried, a 4xx is, and neither reason holds the password", async () => {
  const hard = await setup({ dataReply: `550 no ${PASSWORD}` });
  configure(hard.db, hard.home);
  const a = await emailNotifier(hard).deliver(target, note, "https://h");
  expect(a).toMatchObject({ ok: false, retry: false });
  expect(JSON.stringify(a)).not.toContain(PASSWORD);
  const soft = await setup({ rcptReply: "451 later" });
  configure(soft.db, soft.home);
  const b = await emailNotifier(soft).deliver(target, note, "https://h");
  expect(b).toMatchObject({ ok: false, retry: true });
});

test("SMTP AUTH rejection never includes the encoded credentials", async () => {
  const env = await setup({
    authReply: (command) => `535 refused ${command.split(" ")[2]}`,
  });
  configure(env.db, env.home);
  const result = await emailNotifier(env).deliver(target, note, "https://h");
  expect(result).toEqual({ ok: false, retry: false, reason: "SMTP authentication failed (535)" });
  expect(JSON.stringify(result)).not.toContain(
    Buffer.from(`\0mailer\0${PASSWORD}`).toString("base64"),
  );
});

test("SMTP errors after authentication never include the encoded credentials", async () => {
  const encoded = Buffer.from(`\0mailer\0${PASSWORD}`).toString("base64");
  const env = await setup({ rcptReply: `550 refused ${encoded}` });
  configure(env.db, env.home);
  const result = await emailNotifier(env).deliver(target, note, "https://h");
  expect(result).toMatchObject({ ok: false, retry: false });
  expect(JSON.stringify(result)).not.toContain(encoded);
});

test("unexpected SMTP AUTH replies are not retryable", async () => {
  const env = await setup({ authReply: () => "334 continue" });
  configure(env.db, env.home);
  expect(await emailNotifier(env).deliver(target, note, "https://h")).toMatchObject({
    ok: false,
    retry: false,
  });
});

test("a dropped connection is retryable", async () => {
  const env = await setup({ dropInData: true });
  configure(env.db, env.home);
  expect(await emailNotifier(env).deliver(target, note, "https://h")).toMatchObject({
    ok: false,
    retry: true,
  });
});

test("the code sender is null until SMTP is configured, then mails known users only", async () => {
  const { db, home } = await setup();
  seedMember(db, "ada");
  expect(emailCodeSender(db, home)).toBeNull();
  configure(db, home);
  const send = emailCodeSender(db, home);
  if (!send) throw new Error("sender missing after configuration");
  expect(requestEmailCode(db, "nobody@example.test", send)).toBe("sent");
  expect(requestEmailCode(db, "ada@example.test", send)).toBe("sent");
  await until(() => (fake?.mails.length ?? 0) > 0);
  await Bun.sleep(50);
  expect(fake?.mails).toHaveLength(1);
  expect(fake?.mails[0]?.to).toEqual(["ada@example.test"]);
  expect(fake?.mails[0]?.data).toMatch(/\r\n\r\nYour harness sign-in code is \d{6}\./);
});

test("code delivery logs a fixed error when SMTP rejects the message", async () => {
  const env = await setup({ dataReply: "550 refused code 123456" });
  configure(env.db, env.home);
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values.join(" "));
  try {
    const send = emailCodeSender(env.db, env.home);
    if (!send) throw new Error("sender missing after configuration");
    await send("ada@example.test", "123456");
  } finally {
    console.error = originalError;
  }
  expect(logged).toEqual(["email code delivery failed"]);
});

test("code delivery catches secret-store read failures without exposing their contents", async () => {
  const env = await setup();
  configure(env.db, env.home);
  writeFileSync(join(env.home, "secrets.json"), "invalid code 123456");
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => logged.push(values.join(" "));
  try {
    const send = emailCodeSender(env.db, env.home);
    if (!send) throw new Error("sender missing after configuration");
    await send("ada@example.test", "123456");
  } finally {
    console.error = originalError;
  }
  expect(logged).toEqual(["email code delivery failed"]);
  expect(logged.join(" ")).not.toContain("123456");
});
