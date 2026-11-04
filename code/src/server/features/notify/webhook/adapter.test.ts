import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification, Target } from "../../../../shared/notify";
import { startStub, stopStubs } from "../../../test-support/stub-server";
import { setSecret } from "../../agents/api";
import { webhookNotifier } from "./adapter";
import { sign } from "./sign";

const SECRET = "whsec-test-secret-value";
const note: Notification = {
  kind: "approval_requested",
  orgId: "org1",
  title: "Approval needed",
  body: "rm -rf build",
  path: "/#/approvals/a1",
  tag: "approval:a1",
};

let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-webhook-"));
  setSecret("webhook.t1", SECRET, home);
});
afterAll(stopStubs);

const targetFor = (url: string, secretName = "webhook.t1"): Target => ({
  id: "t1",
  channel: "webhook",
  memberId: "m1",
  value: { url, secretName },
});

test("posts signed json the receiver can verify", async () => {
  const seen: { headers: Headers; raw: string }[] = [];
  const stub = await startStub(async (req) => {
    seen.push({ headers: req.headers, raw: await req.text() });
    return new Response("ok");
  });
  const res = await webhookNotifier(home).deliver(
    targetFor(`${stub.url}/hook`),
    note,
    "https://h.test",
  );
  expect(res).toEqual({ ok: true });
  const [hit] = seen;
  if (!hit) throw new Error("no request seen");
  const ts = Number(hit.headers.get("x-harness-timestamp"));
  expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(5);
  expect(hit.headers.get("x-harness-signature")).toBe(`sha256=${sign(SECRET, ts, hit.raw)}`);
  expect(hit.headers.get("x-harness-event")).toBe("approval_requested");
  const payload = JSON.parse(hit.raw) as Record<string, unknown>;
  expect(payload).toMatchObject({
    kind: "approval_requested",
    orgId: "org1",
    title: "Approval needed",
    body: "rm -rf build",
    url: "https://h.test/#/approvals/a1",
    tag: "approval:a1",
  });
  expect(typeof payload.at).toBe("number");
});

test("5xx retries, 4xx does not, 410 is gone", async () => {
  const status = { code: 500 };
  const stub = await startStub(() => new Response("no", { status: status.code }));
  const notifier = webhookNotifier(home);
  const target = targetFor(stub.url);
  expect(await notifier.deliver(target, note, "https://h.test")).toMatchObject({
    ok: false,
    retry: true,
  });
  status.code = 404;
  expect(await notifier.deliver(target, note, "https://h.test")).toMatchObject({
    ok: false,
    retry: false,
  });
  status.code = 410;
  expect(await notifier.deliver(target, note, "https://h.test")).toMatchObject({
    ok: false,
    retry: false,
    gone: true,
  });
});

test("a redirect is not followed and counts as a failure", async () => {
  const target = await startStub(() => new Response("hit"));
  const stub = await startStub(
    () => new Response(null, { status: 302, headers: { location: target.url } }),
  );
  const res = await webhookNotifier(home).deliver(targetFor(stub.url), note, "https://h.test");
  expect(res).toMatchObject({ ok: false, retry: false });
  expect(target.calls.n).toBe(0);
});

test("a receiver that never answers times out and may be retried", async () => {
  const stub = await startStub(() => new Promise<Response>(() => undefined));
  const res = await webhookNotifier(home, 150).deliver(targetFor(stub.url), note, "https://h.test");
  expect(res).toMatchObject({ ok: false, retry: true });
});

test("private and link-local targets are refused at send time without a request", async () => {
  for (const url of ["https://169.254.169.254/", "https://10.0.0.5/", "https://localhost/"]) {
    const res = await webhookNotifier(home).deliver(targetFor(url), note, "https://h.test");
    expect(res).toMatchObject({ ok: false, retry: false });
  }
});

test("a missing secret fails without a request", async () => {
  const stub = await startStub(() => new Response("ok"));
  const res = await webhookNotifier(home).deliver(
    targetFor(stub.url, "webhook.gone"),
    note,
    "https://h.test",
  );
  expect(res).toMatchObject({ ok: false, retry: false });
  expect(stub.calls.n).toBe(0);
});

test("no failure reason contains the secret", async () => {
  const stub = await startStub(() => new Response(SECRET, { status: 500 }));
  const dead = await startStub(() => new Response("x"));
  const refused = webhookNotifier(home).deliver(
    targetFor("https://10.0.0.5/"),
    note,
    "https://h.test",
  );
  const results = [
    await webhookNotifier(home).deliver(targetFor(stub.url), note, "https://h.test"),
    await webhookNotifier(home, 100).deliver(
      targetFor(dead.url.replace(/:\d+/, ":1")),
      note,
      "https://h.test",
    ),
    await refused,
  ];
  for (const r of results) expect(JSON.stringify(r)).not.toContain(SECRET);
});
