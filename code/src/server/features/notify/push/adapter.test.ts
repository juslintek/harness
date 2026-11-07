import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { newReceiver, startPushStub } from "../../../test-support/push-stub";
import { startStub, stopStubs } from "../../../test-support/stub-server";
import { pushNotifier } from "./adapter";

afterAll(stopStubs);

const note = (kind: Notification["kind"] = "approval_requested"): Notification => ({
  kind,
  orgId: "o",
  title: "Approve?",
  body: "run wants rm",
  path: "/#/approvals/1",
  tag: "approval:1",
});

async function setup(status: number) {
  const home = mkdtempSync(join(tmpdir(), "push-"));
  const stub = await startPushStub(status);
  const rx = newReceiver();
  const target: Target = {
    id: "t",
    channel: "push",
    memberId: "m",
    value: { endpoint: stub.url, p256dh: rx.p256dh, auth: rx.auth },
  };
  return { notifier: pushNotifier({ home }), stub, rx, target, home };
}

test("posts an encrypted, vapid-signed request the receiver can read", async () => {
  const { notifier, stub, rx, target } = await setup(201);
  const res = await notifier.deliver(target, note(), "https://h.example.test");
  expect(res).toEqual({ ok: true });
  const req = stub.requests[0];
  if (!req) throw new Error("no request");
  expect(req.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  expect(req.headers.get("content-encoding")).toBe("aes128gcm");
  expect(req.headers.get("ttl")).toBe("86400");
  expect(req.headers.get("urgency")).toBe("high");
  expect(JSON.parse(rx.decrypt(req.body))).toEqual({
    title: "Approve?",
    body: "run wants rm",
    url: "https://h.example.test/#/approvals/1",
    tag: "approval:1",
  });
});

test("non-approval kinds are normal urgency", async () => {
  const { notifier, stub, target } = await setup(201);
  await notifier.deliver(target, note("mention"), "https://h.example.test");
  expect(stub.requests[0]?.headers.get("urgency")).toBe("normal");
});

test.each([
  [404, { retry: false, gone: true }],
  [410, { retry: false, gone: true }],
  [429, { retry: true }],
  [503, { retry: true }],
  [400, { retry: false }],
  [413, { retry: false }],
])("status %d maps to %p", async (status, expected) => {
  const { notifier, target } = await setup(status);
  const res = await notifier.deliver(target, note(), "https://h.example.test");
  expect(res).toMatchObject({ ok: false, ...expected });
});

test("a failing delivery leaks neither key material nor the endpoint", async () => {
  const { notifier, target, home } = await setup(400);
  const res = await notifier.deliver(target, note(), "https://h.example.test");
  const reason = res.ok ? "" : res.reason;
  const secrets = JSON.parse(readFileSync(join(home, "secrets.json"), "utf8")) as Record<
    string,
    string
  >;
  for (const secret of [
    ...Object.values(secrets),
    target.value.auth,
    target.value.p256dh,
    target.value.endpoint,
  ]) {
    expect(reason).not.toContain(secret ?? "missing");
  }
});

test("an unreachable endpoint retries, a bad subscription is dropped", async () => {
  const { notifier, target } = await setup(201);
  const dead = { ...target, value: { ...target.value, endpoint: "http://127.0.0.1:1/x" } };
  expect(await notifier.deliver(dead, note(), "https://h")).toMatchObject({
    ok: false,
    retry: true,
  });
  const http = { ...target, value: { ...target.value, endpoint: "http://example.test/x" } };
  expect(await notifier.deliver(http, note(), "https://h")).toMatchObject({
    ok: false,
    gone: true,
  });
  const badKey = { ...target, value: { ...target.value, p256dh: "AAAA" } };
  expect(await notifier.deliver(badKey, note(), "https://h")).toMatchObject({
    ok: false,
    gone: true,
  });
});

test("a temporary DNS failure retries without dropping the push subscription", async () => {
  const { target, home } = await setup(201);
  const notifier = pushNotifier({ home }, async () => ({ ok: false, retry: true }));
  expect(await notifier.deliver(target, note(), "https://h")).toEqual({
    ok: false,
    retry: true,
    reason: "invalid push subscription",
  });
});

test.each([
  "https://127.0.0.1/push",
  "https://10.0.0.5/push",
  "https://169.254.169.254/latest/meta-data/",
  "https://[::ffff:127.0.0.1]/push",
])("private push endpoint %s is refused before a request", async (endpoint) => {
  const { notifier, stub, target } = await setup(201);
  const res = await notifier.deliver(
    { ...target, value: { ...target.value, endpoint } },
    note(),
    "https://h.example.test",
  );
  expect(res).toMatchObject({ ok: false, retry: false, gone: true });
  expect(stub.requests).toHaveLength(0);
});

test("push requests do not follow redirects", async () => {
  const receiver = await startStub(() => new Response("received"));
  const redirect = await startStub(
    () => new Response(null, { status: 302, headers: { location: receiver.url } }),
  );
  const { notifier, target } = await setup(201);
  const res = await notifier.deliver(
    { ...target, value: { ...target.value, endpoint: `${redirect.url}/push` } },
    note(),
    "https://h.example.test",
  );
  expect(res).toMatchObject({ ok: false, retry: false });
  expect(receiver.calls.n).toBe(0);
});
