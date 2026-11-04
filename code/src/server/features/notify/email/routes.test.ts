import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { migrate, openDb } from "../../../db/db";
import { migrations } from "../../../db/migrations";
import { withActor } from "../../../test-support/app-kit";
import { type SmtpFake, startSmtpFake } from "../../../test-support/smtp-fake";
import { getSecret } from "../../agents/api";
import type { AuthEnv } from "../../auth/api";
import { seedMember } from "../fake-notifier";
import { emailRoutes } from "./routes";

const PASSWORD = "hunter2-s3cret";
let fake: SmtpFake | null = null;

afterEach(() => {
  fake?.stop();
  fake = null;
});

function setup(): { db: Database; home: string; userId: string } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  return {
    db,
    home: mkdtempSync(join(tmpdir(), "harness-email-")),
    userId: seedMember(db, "ada").userId,
  };
}

const put = (app: Hono<AuthEnv>, body: unknown): Response | Promise<Response> =>
  app.request("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const config = (port: number): Record<string, unknown> => ({
  host: "127.0.0.1",
  port,
  security: "none",
  user: "mailer",
  from: "harness@example.test",
  password: PASSWORD,
});

test("a non-admin is 403 on both routes", async () => {
  const { db, home, userId } = setup();
  const app = withActor(emailRoutes(db, home), { userId, instanceAdmin: false });
  expect((await put(app, config(25))).status).toBe(403);
  expect((await app.request("/test", { method: "POST" })).status).toBe(403);
});

test("saving needs a fresh step-up", async () => {
  const { db, home, userId } = setup();
  const app = withActor(emailRoutes(db, home), { userId, stepUpAt: null });
  const res = await put(app, config(25));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "step_up_required" });
  expect(db.query("SELECT count(*) AS n FROM notify_settings").get()).toEqual({ n: 0 });
});

test("the password goes to the secrets file only and is never echoed", async () => {
  const { db, home, userId } = setup();
  const app = withActor(emailRoutes(db, home), { userId });
  const res = await put(app, config(25));
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain(PASSWORD);
  expect(getSecret("smtp.password", home)).toBe(PASSWORD);
  const rows = JSON.stringify(db.query("SELECT key, value FROM notify_settings").all());
  expect(rows).not.toContain(PASSWORD);
  expect(rows).toContain("127.0.0.1");
});

test("a bad config is 400 and a later save without password keeps the old one", async () => {
  const { db, home, userId } = setup();
  const app = withActor(emailRoutes(db, home), { userId });
  expect((await put(app, { ...config(25), port: 0 })).status).toBe(400);
  await put(app, config(25));
  const { password: _kept, ...noPassword } = config(2525);
  expect((await put(app, noPassword)).status).toBe(200);
  expect(getSecret("smtp.password", home)).toBe(PASSWORD);
});

test("the test route mails the caller's own address", async () => {
  const { db, home, userId } = setup();
  fake = await startSmtpFake();
  const app = withActor(emailRoutes(db, home), { userId });
  expect((await app.request("/test", { method: "POST" })).status).toBe(400);
  await put(app, config(fake.port));
  const res = await app.request("/test", { method: "POST" });
  expect(res.status).toBe(200);
  expect(fake.mails[0]?.to).toEqual(["ada@example.test"]);
});

test("a failing test send answers 502 without the password", async () => {
  const { db, home, userId } = setup();
  fake = await startSmtpFake({ dataReply: `550 no ${PASSWORD}` });
  const app = withActor(emailRoutes(db, home), { userId });
  await put(app, config(fake.port));
  const res = await app.request("/test", { method: "POST" });
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain(PASSWORD);
});
