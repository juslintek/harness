import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { migrate, openDb } from "../../../db/db";
import { migrations } from "../../../db/migrations";
import { withActor } from "../../../test-support/app-kit";
import { getSecret } from "../../agents/api";
import type { AuthEnv } from "../../auth/api";
import { seedMember } from "../fake-notifier";
import { notifyRoutes } from "../routes";

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-webhook-add-"));
});

function setup(): { app: Hono<AuthEnv>; db: ReturnType<typeof openDb> } {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const ada = seedMember(db, "ada");
  return {
    db,
    app: withActor(notifyRoutes(db, home), { userId: ada.userId, instanceAdmin: false }),
  };
}

const post = (app: Hono<AuthEnv>, body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request("/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("a generated secret is returned once and stored under webhook.<id>", async () => {
  const { app } = setup();
  const res = await post(app, { channel: "webhook", url: "https://93.184.216.34/in" });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { id: string; secret: string; note: string };
  expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(created.note).toContain("5 minutes");
  expect(getSecret(`webhook.${created.id}`, home)).toBe(created.secret);
  const list = await (await Promise.resolve(app.request("/targets"))).text();
  expect(list).not.toContain(created.secret);
  expect(list).not.toContain("secretName");
  expect(list).toContain("https://93.184.216.34/in");
});

test("a caller supplied secret is kept", async () => {
  const { app } = setup();
  const secret = "my-own-secret-0123456789";
  const res = await post(app, { channel: "webhook", url: "https://93.184.216.34/in", secret });
  const created = (await res.json()) as { id: string; secret: string };
  expect(created.secret).toBe(secret);
  expect(getSecret(`webhook.${created.id}`, home)).toBe(secret);
});

test("link-local, private and plain http urls are refused and store nothing", async () => {
  const { app, db } = setup();
  const urls = [
    "https://169.254.169.254/",
    "https://10.0.0.5/",
    "http://example.com/",
    "https://localhost/",
  ];
  for (const url of urls) {
    expect((await post(app, { channel: "webhook", url })).status).toBe(400);
  }
  expect(db.query("SELECT count(*) AS n FROM notify_targets").get()).toEqual({ n: 0 });
});

test("a webhook cannot be created with a client chosen secret name", async () => {
  const { app } = setup();
  const res = await post(app, {
    channel: "webhook",
    value: { url: "https://93.184.216.34/in", secretName: "smtp.password" },
  });
  expect(res.status).toBe(400);
});
