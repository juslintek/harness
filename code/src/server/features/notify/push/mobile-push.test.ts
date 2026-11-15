import { afterAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { migrate, openDb } from "../../../db/db";
import { migrations } from "../../../db/migrations";
import { withActor } from "../../../test-support/app-kit";
import { seedMember } from "../../../test-support/bridge-kit";
import { newReceiver } from "../../../test-support/push-stub";
import { startStub, stopStubs } from "../../../test-support/stub-server";
import { createOutbox } from "../outbox";
import { notifyRoutes } from "../routes";
import { targetsOf } from "../targets-repo";
import { pushNotifier } from "./adapter";
import { deepLinkFor } from "./mobile-push";

afterAll(stopStubs);

function setup() {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const home = mkdtempSync(join(tmpdir(), "mobilepush-"));
  const ada = seedMember(db, "ada");
  const app = withActor(notifyRoutes(db, home), { userId: ada.userId, instanceAdmin: false });
  return { db, home, ada, app };
}

const postMobile = (app: ReturnType<typeof setup>["app"], body: unknown) =>
  Promise.resolve(
    app.request("/push/mobile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("POST /push/mobile rejects SSRF endpoints", async () => {
  const { app } = setup();
  const base = { platform: "ios", appId: "dev.harness.mobile", pushToken: "tok-1234567890123456" };

  const linkLocal = await postMobile(app, { ...base, relayUrl: "http://169.254.169.254/push" });
  expect(linkLocal.status).toBe(400);

  const privateIp = await postMobile(app, { ...base, relayUrl: "https://10.0.0.1/push" });
  expect(privateIp.status).toBe(400);
});

test("POST /push/mobile registers target and deduplicates by token", async () => {
  const { app } = setup();
  const body = {
    relayUrl: "http://127.0.0.1:9/relay",
    platform: "ios",
    appId: "dev.harness.mobile",
    pushToken: "device-push-token-12345",
    relaySecret: "super-secret-hmac-key-12345",
  };

  const first = await postMobile(app, body);
  expect(first.status).toBe(201);
  const { id } = (await first.json()) as { id: string };
  expect(typeof id).toBe("string");

  const second = await postMobile(app, body);
  expect(second.status).toBe(201);
  expect((await second.json()) as { id: string }).toEqual({ id });
});

test("push targets list both Mobile Push and Web Push with clean labels", async () => {
  const { app, db, ada, home } = setup();
  const reg = await postMobile(app, {
    relayUrl: "http://127.0.0.1:9/relay",
    platform: "ios",
    appId: "dev.harness.mobile",
    pushToken: "device-push-token-12345",
    relaySecret: "super-secret-hmac-key-12345",
  });
  const { id } = (await reg.json()) as { id: string };

  const rx = newReceiver();
  await app.request("/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: "http://127.0.0.1:9/web-push",
      keys: { p256dh: rx.p256dh, auth: rx.auth },
    }),
  });

  const listRes = await app.request("/targets");
  const targets = (await listRes.json()) as Array<{ id: string; channel: string; label: string }>;
  expect(targets).toHaveLength(2);
  expect(targets.find((t) => t.id === id)).toEqual({
    id,
    channel: "push",
    label: "ios:dev.harness.mobile",
  });
  expect(targets.find((t) => t.id !== id)).toMatchObject({ channel: "push", label: "127.0.0.1:9" });

  const delRes = await app.request(`/targets/${id}`, { method: "DELETE" });
  expect(delRes.status).toBe(200);
  const secrets = JSON.parse(readFileSync(join(home, "secrets.json"), "utf8")) as Record<
    string,
    string
  >;
  expect(secrets[`push.${id}`]).toBeUndefined();
  expect(targetsOf(db, ada.memberId, "push")).toHaveLength(1);
});

async function setupDelivery(secretKey: string) {
  let capturedBody = "";
  let capturedHeaders: Headers | undefined;
  const relayStub = await startStub(async (req) => {
    capturedHeaders = req.headers;
    capturedBody = await req.text();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const home = mkdtempSync(join(tmpdir(), "mobilepush-send-"));
  const target: Target = {
    id: "mob-target-1",
    channel: "push",
    memberId: "m1",
    value: {
      kind: "mobile_relay",
      relayUrl: relayStub.url,
      platform: "ios",
      appId: "dev.harness.mobile",
      pushToken: "apns-token-abc",
      secretName: "push.mob-target-1",
    },
  };
  await Bun.write(join(home, "secrets.json"), JSON.stringify({ "push.mob-target-1": secretKey }));
  return {
    notifier: pushNotifier({ home }),
    target,
    getCaptured: () => ({ body: capturedBody, headers: capturedHeaders }),
  };
}

test("mobile push delivery sends privacy-preserving signed envelope without body leak", async () => {
  const secretKey = "relay-secret-for-signing-123456";
  const { notifier, target, getCaptured } = await setupDelivery(secretKey);

  const note: Notification = {
    kind: "approval_requested",
    orgId: "org-xyz",
    title: "Sensitive Action Title",
    body: "Confidential credentials or terminal commands",
    path: "/#/approvals/appr-42",
    tag: "approval:appr-42",
  };

  const result = await notifier.deliver(target, note, "https://harness.test");
  expect(result).toEqual({ ok: true });

  const { body, headers } = getCaptured();
  const expectedSig = `sha256=${createHmac("sha256", secretKey).update(body).digest("hex")}`;
  expect(headers?.get("x-harness-push-signature")).toBe(expectedSig);

  const envelope = JSON.parse(body) as Record<string, unknown>;
  expect(envelope).toMatchObject({
    version: 1,
    platform: "ios",
    appId: "dev.harness.mobile",
    pushToken: "apns-token-abc",
    kind: "approval_requested",
    urgency: "time-sensitive",
    tag: "approval:appr-42",
    deepLink: "harness://approvals/appr-42",
    instanceOrigin: "https://harness.test",
  });
  expect(typeof envelope.ts).toBe("number");
  expect(body).not.toContain("Sensitive Action Title");
  expect(body).not.toContain("Confidential credentials");
});

test("mobile push delivery propagates 410 gone and outbox prunes the target", async () => {
  const relayStub = await startStub(() => new Response("unregistered", { status: 410 }));
  const { db, home, ada } = setup();

  const target: Target = {
    id: "target-gone",
    channel: "push",
    memberId: ada.memberId,
    value: {
      kind: "mobile_relay",
      relayUrl: relayStub.url,
      platform: "android",
      appId: "dev.harness.mobile",
      pushToken: "tok-gone",
    },
  };
  db.query(
    "INSERT INTO notify_targets (id, member_id, channel, value, created_at) VALUES (?, ?, 'push', ?, ?)",
  ).run(target.id, target.memberId, JSON.stringify(target.value), Date.now());

  const notifier = pushNotifier({ home });
  const outbox = createOutbox({
    db,
    home,
    adapters: {
      push: notifier,
      email: notifier,
      slack: notifier,
      telegram: notifier,
      webhook: notifier,
    },
    origin: "https://harness.test",
    now: Date.now,
    backoffMs: [1000],
  });

  const note: Notification = {
    kind: "mention",
    orgId: "org-1",
    title: "t",
    body: "b",
    path: "/#/o/acme/chat/gen",
    tag: "mention:1",
  };

  outbox.send(target, note);
  await outbox.idle();
  expect(targetsOf(db, ada.memberId, "push")).toHaveLength(0);
});

test("deepLinkFor maps known notification paths and falls back to harness://open", () => {
  const dummy: Omit<Notification, "path"> = {
    kind: "mention",
    orgId: "o",
    title: "t",
    body: "b",
    tag: "tag",
  };
  expect(deepLinkFor({ ...dummy, path: "/#/approvals/appr-123" })).toBe(
    "harness://approvals/appr-123",
  );
  expect(deepLinkFor({ ...dummy, path: "/#/o/acme/chat/general" })).toBe(
    "harness://chat/acme/general",
  );
  expect(deepLinkFor({ ...dummy, path: "/#/runs/run-99" })).toBe("harness://runs/run-99");
  expect(deepLinkFor({ ...dummy, path: "/#/settings/team" })).toBe(
    "harness://open?path=%2F%23%2Fsettings%2Fteam",
  );
});
