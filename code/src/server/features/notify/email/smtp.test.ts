import { afterEach, expect, test } from "bun:test";
import { type SmtpFake, type SmtpFakeOpts, startSmtpFake } from "../../../test-support/smtp-fake";
import type { SmtpConfig } from "./config";
import { SmtpError, sendMail } from "./smtp";

const PASSWORD = "hunter2-s3cret";
const mail = { to: "ada@example.test", subject: "hello", text: "line one\r\n.x\r\nlast" };
let fake: SmtpFake | null = null;

afterEach(() => {
  fake?.stop();
  fake = null;
});

async function setup(
  opts: SmtpFakeOpts,
  security: SmtpConfig["security"],
  extra: Partial<SmtpConfig> = {},
): Promise<SmtpConfig> {
  fake?.stop();
  fake = await startSmtpFake(opts);
  return { host: "localhost", port: fake.port, security, from: "harness@example.test", ...extra };
}

async function failure(run: Promise<void>): Promise<SmtpError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof SmtpError)) throw new Error("expected SmtpError");
  return err;
}

test("a plain delivery reaches the server with envelope and headers", async () => {
  const cfg = await setup({}, "none");
  await sendMail(cfg, mail);
  const got = fake?.mails[0];
  expect(got?.from).toBe("harness@example.test");
  expect(got?.to).toEqual(["ada@example.test"]);
  expect(got?.data).toContain("Subject: hello");
  expect(got?.data).toContain("To: ada@example.test");
});

test("a body line starting with a dot survives dot-stuffing", async () => {
  const cfg = await setup({}, "none");
  await sendMail(cfg, mail);
  expect(fake?.mails[0]?.data.split("\r\n")).toContain(".x");
});

test("AUTH PLAIN sends user and password as base64", async () => {
  const cfg = await setup({}, "none", { host: "127.0.0.1", user: "mailer" });
  await sendMail(cfg, mail, { password: PASSWORD });
  expect(fake?.auths).toEqual([`\0mailer\0${PASSWORD}`]);
});

test("a header value with a line break is rejected before any connection", async () => {
  const cfg = await setup({}, "none");
  const err = await failure(sendMail(cfg, { ...mail, subject: "hi\r\nBcc: evil@example.test" }));
  expect(err.retry).toBe(false);
  expect(fake?.commands).toEqual([]);
  await failure(sendMail(cfg, { ...mail, to: "a@b.test\nBcc: x@y.test" }));
  await failure(sendMail({ ...cfg, from: "a@b.test>\r\nRCPT TO:<x@y.test" }, mail));
});

test("a 550 reply is not retryable and a 4xx is", async () => {
  const hard = await setup({ dataReply: "550 mailbox unavailable" }, "none");
  expect((await failure(sendMail(hard, mail))).retry).toBe(false);
  const soft = await setup({ rcptReply: "451 try later" }, "none");
  expect((await failure(sendMail(soft, mail))).retry).toBe(true);
});

test("a connection closed mid-DATA is retryable", async () => {
  const cfg = await setup({ dropInData: true }, "none");
  expect((await failure(sendMail(cfg, mail))).retry).toBe(true);
});

test("a silent server hits the per-command timeout", async () => {
  const cfg = await setup({ silent: true }, "none");
  const err = await failure(sendMail(cfg, mail, { timeoutMs: 150 }));
  expect(err.retry).toBe(true);
  expect(err.message).toContain("timed out");
});

test("an error never contains the password", async () => {
  const cfg = await setup({ dataReply: `550 bad ${PASSWORD}` }, "none", {
    host: "127.0.0.1",
    user: "mailer",
  });
  const err = await failure(sendMail(cfg, mail, { password: PASSWORD }));
  expect(err.message).not.toContain(PASSWORD);
});

test("implicit TLS delivers over an encrypted connection", async () => {
  const cfg = await setup({ tls: "implicit" }, "tls", { user: "mailer" });
  await sendMail(cfg, mail, { password: PASSWORD, ca: fake?.cert ?? "" });
  expect(fake?.mails).toHaveLength(1);
  expect(fake?.auths).toHaveLength(1);
});

test("STARTTLS upgrades before AUTH and delivers", async () => {
  const cfg = await setup({ tls: "starttls" }, "starttls", { user: "mailer" });
  await sendMail(cfg, mail, { password: PASSWORD, ca: fake?.cert ?? "" });
  const verbs = fake?.commands.map((c) => c.split(" ")[0]);
  expect(verbs?.indexOf("STARTTLS")).toBeLessThan(verbs?.indexOf("AUTH") ?? -1);
  expect(fake?.mails).toHaveLength(1);
});

test("a certificate the client does not trust fails the TLS handshake", async () => {
  const cfg = await setup({ tls: "implicit" }, "tls");
  expect((await failure(sendMail(cfg, mail))).retry).toBe(false);
});

test("a password is not sent in clear text to a remote host", async () => {
  const cfg = await setup({}, "none", { host: "mail.example.test", user: "mailer" });
  const err = await failure(sendMail(cfg, mail, { password: PASSWORD }));
  expect(err.message).toContain("clear text");
  expect(err.message).not.toContain(PASSWORD);
});
