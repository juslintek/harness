import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification } from "../../../shared/notify";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { seedMember } from "../../test-support/bridge-kit";
import { secretNames, setSecret } from "../agents/api";
import { addTarget, listTargets, notifyMembers, setPref, startNotify } from "./api";
import { createDispatcher } from "./dispatcher";
import { type FakeNotifier, fakeNotifier } from "./fake-notifier";

const note = (over: Partial<Notification> = {}): Notification => ({
  kind: "mention",
  orgId: "o1",
  title: "ping",
  body: "hello",
  path: "/#/x",
  tag: "t1",
  ...over,
});

const push = { endpoint: "https://push.test/1", p256dh: "k", auth: "a" };

function setup(script: Parameters<typeof fakeNotifier>[1] = []): {
  db: Database;
  memberId: string;
  fake: FakeNotifier;
  clock: { t: number };
  dispatcher: ReturnType<typeof createDispatcher>;
} {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const memberId = seedMember(db, "ada").memberId;
  const fake = fakeNotifier("push", script);
  const clock = { t: 1_000_000 };
  const dispatcher = createDispatcher(db, {
    home: "/nonexistent",
    origin: "https://h.test",
    adapters: { push: fake },
    now: () => clock.t,
    backoffMs: [1, 1, 1],
  });
  return { db, memberId, fake, clock, dispatcher };
}

const logs = (db: Database): { status: string; attempts: number; reason: string | null }[] =>
  db
    .query<{ status: string; attempts: number; reason: string | null }, []>(
      "SELECT status, attempts, reason FROM notify_log ORDER BY at, rowid",
    )
    .all();

test("a disabled pref sends nothing and writes no row", async () => {
  const { db, memberId, fake, dispatcher } = setup();
  addTarget(db, memberId, "push", push);
  setPref(db, memberId, "push", "mention", false);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(0);
  expect(logs(db)).toEqual([]);
});

test("a member without a target for the enabled channel is skipped", async () => {
  const { memberId, fake, dispatcher } = setup();
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(0);
});

test("two targets of one channel get two sends with the public origin", async () => {
  const { db, memberId, fake, dispatcher } = setup();
  addTarget(db, memberId, "push", push);
  addTarget(db, memberId, "push", { ...push, endpoint: "https://push.test/2" });
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]?.base).toBe("https://h.test");
  expect(logs(db).map((l) => l.status)).toEqual(["sent", "sent"]);
});

test("retry then ok is one sent row with two attempts", async () => {
  const { db, memberId, fake, dispatcher } = setup([{ ok: false, retry: true, reason: "503" }]);
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(2);
  expect(logs(db)).toEqual([{ status: "sent", attempts: 2, reason: null }]);
});

test("retries stop after three and the row says failed with the last reason", async () => {
  const down = { ok: false, retry: true, reason: "503" } as const;
  const { db, memberId, fake, dispatcher } = setup([down, down, down, down, down]);
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(4);
  expect(logs(db)).toEqual([{ status: "failed", attempts: 4, reason: "503" }]);
});

test("a permanent failure is not retried", async () => {
  const { db, memberId, fake, dispatcher } = setup([{ ok: false, retry: false, reason: "bad" }]);
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(1);
  expect(logs(db)).toEqual([{ status: "failed", attempts: 1, reason: "bad" }]);
});

test("an adapter that throws becomes a failed row and does not reject", async () => {
  const { db, memberId, dispatcher } = setup();
  const boom = { channel: "push", deliver: () => Promise.reject(new Error("kaput")) } as const;
  const d = createDispatcher(db, {
    home: "/nonexistent",
    origin: "https://h.test",
    adapters: { push: boom },
  });
  addTarget(db, memberId, "push", push);
  d.notify([memberId], note());
  await d.idle();
  expect(logs(db)).toEqual([{ status: "failed", attempts: 1, reason: "kaput" }]);
  await dispatcher.stop();
});

test("gone deletes the target", async () => {
  const gone = { ok: false, retry: false, gone: true, reason: "410" } as const;
  const { db, memberId, dispatcher } = setup([gone]);
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(listTargets(db, memberId)).toEqual([]);
  expect(logs(db)[0]?.status).toBe("failed");
});

test("gone on a webhook target also removes its secret", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-gone-"));
  const gone = { ok: false, retry: false, gone: true, reason: "410" } as const;
  const { db, memberId } = setup();
  const dispatcher = createDispatcher(db, {
    home,
    origin: "https://h.test",
    adapters: { webhook: fakeNotifier("webhook", [gone]) },
    backoffMs: [1],
  });
  addTarget(db, memberId, "webhook", { url: "https://h.test/in", secretName: "webhook.w1" });
  setSecret("webhook.w1", "s", home);
  setPref(db, memberId, "webhook", "mention", true);
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(listTargets(db, memberId)).toEqual([]);
  expect(secretNames(home)).toEqual([]);
});

test("the same tag to the same target within 60 s is dropped, later it is sent", async () => {
  const { db, memberId, fake, clock, dispatcher } = setup();
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  clock.t += 59_000;
  dispatcher.notify([memberId], note());
  clock.t += 2_000;
  dispatcher.notify([memberId], note());
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(2);
  expect(logs(db).map((l) => l.status)).toEqual(["dropped", "sent", "sent"]);
});

test("another tag or another target is not a duplicate", async () => {
  const { db, memberId, fake, dispatcher } = setup();
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note());
  dispatcher.notify([memberId], note({ tag: "t2" }));
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(2);
});

test("the 31st send of a member inside a minute is dropped, and the window rolls", async () => {
  const { db, memberId, fake, clock, dispatcher } = setup();
  addTarget(db, memberId, "push", push);
  for (let i = 0; i < 31; i++) dispatcher.notify([memberId], note({ tag: `t${i}` }));
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(30);
  expect(logs(db).filter((l) => l.status === "dropped")).toHaveLength(1);
  clock.t += 61_000;
  dispatcher.notify([memberId], note({ tag: "later" }));
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(31);
});

test("the cap is per member", async () => {
  const { db, memberId, fake, dispatcher } = setup();
  const other = seedMember(db, "bob").memberId;
  addTarget(db, memberId, "push", push);
  addTarget(db, other, "push", push);
  for (let i = 0; i < 30; i++) dispatcher.notify([memberId], note({ tag: `t${i}` }));
  dispatcher.notify([other], note({ tag: "x" }));
  await dispatcher.idle();
  expect(fake.calls).toHaveLength(31);
});

test("title and body are redacted before the adapter sees them and no body is stored", async () => {
  const { db, memberId, fake, dispatcher } = setup();
  const token = `ghp_${"a".repeat(36)}`;
  addTarget(db, memberId, "push", push);
  dispatcher.notify([memberId], note({ title: `t ${token}`, body: `leak ${token}` }));
  await dispatcher.idle();
  const seen = JSON.stringify(fake.calls[0]?.n);
  expect(seen).not.toContain(token);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(notify_log)").all();
  expect(columns.map((c) => c.name)).not.toContain("body");
  expect(JSON.stringify(db.query("SELECT * FROM notify_log").all())).not.toContain("leak");
});

test("stop cancels a pending retry, logs it and resolves at once", async () => {
  const { db, memberId, fake, dispatcher } = setup([{ ok: false, retry: true, reason: "503" }]);
  const slow = createDispatcher(db, {
    home: "/nonexistent",
    origin: "https://h.test",
    adapters: { push: fake },
    backoffMs: [60_000],
  });
  addTarget(db, memberId, "push", push);
  slow.notify([memberId], note());
  await Bun.sleep(5);
  const started = performance.now();
  await slow.stop();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(fake.calls).toHaveLength(1);
  expect(logs(db)).toEqual([{ status: "failed", attempts: 1, reason: "stopped" }]);
  slow.notify([memberId], note({ tag: "after" }));
  await dispatcher.stop();
  expect(fake.calls).toHaveLength(1);
});

test("stop does not schedule a retry when an in-flight delivery returns late", async () => {
  const { db, memberId } = setup();
  let resolveDelivery!: (result: { ok: false; retry: true; reason: string }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const pending = new Promise<{ ok: false; retry: true; reason: string }>(
    (resolve) => (resolveDelivery = resolve),
  );
  const slow = createDispatcher(db, {
    home: "/nonexistent",
    origin: "https://h.test",
    adapters: {
      push: {
        channel: "push",
        deliver: async () => {
          markStarted();
          return pending;
        },
      },
    },
    backoffMs: [60_000],
  });
  addTarget(db, memberId, "push", push);
  slow.notify([memberId], note());
  await started;
  const stopping = slow.stop();
  resolveDelivery({ ok: false, retry: true, reason: "503" });
  await stopping;
  expect(logs(db)).toEqual([{ status: "failed", attempts: 1, reason: "stopped" }]);
});

test("notifyMembers reaches the dispatcher of its db, and never throws without one", async () => {
  const { db, memberId } = setup();
  notifyMembers(db, [memberId], note());
  const fake = fakeNotifier("push");
  addTarget(db, memberId, "push", push);
  const stop = startNotify(db, {
    home: "/nope",
    origin: "https://h.test",
    adapters: { push: fake },
  });
  notifyMembers(db, [memberId, "no-such-member"], note());
  await stop();
  expect(fake.calls).toHaveLength(1);
});
