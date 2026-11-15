import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createRelayHandler } from "./relay";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const validIos = {
  version: 1,
  platform: "ios",
  appId: "dev.harness.mobile",
  pushToken: "apns-token-12345",
  kind: "approval_requested",
  urgency: "time-sensitive",
  tag: "approval:42",
  deepLink: "harness://approvals/42",
  instanceOrigin: "https://harness.example.com",
  ts: 1763000000000,
};

test("rejects missing or invalid HMAC signature when secret is configured", async () => {
  const secret = "test-relay-secret-1234";
  const handler = createRelayHandler({ secret });
  const rawBody = JSON.stringify(validIos);

  const noSig = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    }),
  );
  expect(noSig.status).toBe(401);

  const badSig = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-push-signature": "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
      },
      body: rawBody,
    }),
  );
  expect(badSig.status).toBe(401);

  let capturedUrl = "";
  const goodHandler = createRelayHandler({
    secret,
    fetch: async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const good = await goodHandler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-push-signature": sign(secret, rawBody),
      },
      body: rawBody,
    }),
  );
  expect(good.status).toBe(200);
  expect(capturedUrl).toContain("apns-token-12345");
});

test("rejects invalid envelope payloads", async () => {
  const handler = createRelayHandler({});

  const badVersion = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validIos, version: 2 }),
    }),
  );
  expect(badVersion.status).toBe(400);

  const badPlatform = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validIos, platform: "web" }),
    }),
  );
  expect(badPlatform.status).toBe(400);

  const missingToken = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validIos, pushToken: "" }),
    }),
  );
  expect(missingToken.status).toBe(400);
});

test("translates ios envelope into APNs HTTP/2 wire request", async () => {
  let reqUrl = "";
  let reqHeaders: Headers | undefined;
  let reqBody: unknown;

  const handler = createRelayHandler({
    fetch: async (input, init) => {
      reqUrl = String(input);
      reqHeaders = new Headers(init?.headers);
      reqBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    },
  });

  const res = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validIos),
    }),
  );
  expect(res.status).toBe(200);
  expect(reqUrl).toBe("https://api.push.apple.com/3/device/apns-token-12345");
  expect(reqHeaders?.get("apns-push-type")).toBe("alert");
  expect(reqHeaders?.get("apns-priority")).toBe("10");
  expect(reqHeaders?.get("apns-topic")).toBe("dev.harness.mobile");

  expect(reqBody).toMatchObject({
    aps: {
      alert: {
        title: "Approval Requested",
        body: "Action requires your approval",
      },
      "interruption-level": "time-sensitive",
      "mutable-content": 1,
    },
    deepLink: "harness://approvals/42",
    instanceOrigin: "https://harness.example.com",
    kind: "approval_requested",
  });
});

test("translates android envelope into FCM HTTP v1 wire request", async () => {
  let reqUrl = "";
  let reqHeaders: Headers | undefined;
  let reqBody: unknown;

  const handler = createRelayHandler({
    fcmProjectId: "test-project",
    fcmToken: "mock-token",
    fetch: async (input, init) => {
      reqUrl = String(input);
      reqHeaders = new Headers(init?.headers);
      reqBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ name: "projects/test-project/messages/1" }), {
        status: 200,
      });
    },
  });

  const androidEnvelope = {
    ...validIos,
    platform: "android",
    pushToken: "fcm-token-67890",
    kind: "mention",
    urgency: "active",
    tag: "mention:10",
    deepLink: "harness://chat/team/general",
  };

  const res = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(androidEnvelope),
    }),
  );
  expect(res.status).toBe(200);
  expect(reqUrl).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
  expect(reqHeaders?.get("authorization")).toBe("Bearer mock-token");
  expect(reqBody).toEqual({
    message: {
      token: "fcm-token-67890",
      android: {
        priority: "HIGH",
      },
      data: {
        deepLink: "harness://chat/team/general",
        instanceOrigin: "https://harness.example.com",
        kind: "mention",
        urgency: "active",
        tag: "mention:10",
      },
    },
  });
});

test("propagates 410 Unregistered from APNs and FCM", async () => {
  const handler = createRelayHandler({
    fetch: async () => new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 }),
  });

  const res = await handler(
    new Request("http://localhost/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validIos),
    }),
  );
  expect(res.status).toBe(410);
});
