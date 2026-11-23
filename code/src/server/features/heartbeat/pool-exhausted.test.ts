import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Notification } from "../../../shared/notify";
import { getTask, updateTask } from "../board/api";
import { addTarget, setPref, startNotify } from "../notify/api";
import { setPolicy } from "../policies/api";
import type { RunDeps } from "../runtimes/api";
import { recordQuota } from "../usage/api";
import { setup, specFor, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

type Outcome = Awaited<ReturnType<NonNullable<RunDeps["lane"]>>>;
const ok: Outcome = { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
const rateLimited: Outcome = { ...ok, stopReason: "error", error: "429 rate limit exceeded" };

function addClaudeAccount(k: ReturnType<typeof setup>, id: string): void {
  const dir = join(k.home, "accounts", id);
  mkdirSync(dir, { recursive: true });
  k.db.run(
    `INSERT INTO agent_accounts (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, 'claude', 'login', ?, ?, 'active', 2, 1, 1)`,
    [id, id, dir],
  );
}

function onlyClaude(k: ReturnType<typeof setup>): void {
  setPolicy(k.db, {
    layer: "org",
    targetId: k.orgId,
    key: "router.allowedRuntimes",
    value: ["claude"],
    setBy: k.human.id,
  });
}

function captureNotifications(k: ReturnType<typeof setup>): Notification[] {
  const sent: Notification[] = [];
  addTarget(k.db, k.human.id, "email", { address: "admin@example.com" });
  setPref(k.db, k.human.id, "email", "pool_exhausted", true);
  stops.push(
    startNotify(k.db, {
      home: k.home,
      origin: "http://localhost:4100",
      adapters: {
        email: {
          channel: "email",
          deliver: async (_target, n) => {
            sent.push(n);
            return { ok: true };
          },
        },
      },
    }),
  );
  return sent;
}

function parkedWake(k: ReturnType<typeof setup>, memberId: string) {
  return k.db
    .query<{ status: string; not_before: number | null; detail: string | null }, [string]>(
      "SELECT status, not_before, detail FROM wakeups WHERE member_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(memberId);
}

function seedExhaustedPair(k: ReturnType<typeof setup>, resetA: number, resetB: number): void {
  onlyClaude(k);
  addClaudeAccount(k, "claude-a");
  addClaudeAccount(k, "claude-b");
  for (const [accountId, resetsAt] of [
    ["claude-a", resetA],
    ["claude-b", resetB],
  ] as const) {
    recordQuota(k.db, {
      provider: "claude",
      accountId,
      window: "five_hour",
      usedPercent: 100,
      resetsAt,
      source: "manual",
    });
  }
}

test("all accounts exhausted parks the wake at earliest reset (>=60s), keeps task unblocked, notifies once, then runs on recovery", async () => {
  const k = setup();
  const now = Date.now();
  seedExhaustedPair(k, now + 10_000, now + 180_000);
  const sent = captureNotifications(k);
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), accountIsolation: true });
  const b = k.agent("bob", [], "claude");
  stops.push(k.start());

  const task = k.task("fix bug");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);

  await until(() => parkedWake(k, b.id)?.not_before !== null);
  const parked = parkedWake(k, b.id);
  expect(parked?.status).toBe("pending");
  expect(parked?.not_before ?? 0).toBeGreaterThanOrEqual(now + 59_000);
  expect(getTask(k.db, task.id)?.status).toBe("backlog");

  updateTask(k.db, k.task("second bug").id, { assigneeId: b.id }, k.human.id);
  await Bun.sleep(150);
  expect(sent.filter((n) => n.kind === "pool_exhausted")).toHaveLength(1);

  k.db.run("UPDATE quota_snapshots SET resets_at = ? WHERE account_id = 'claude-a'", [
    Date.now() - 1000,
  ]);
  k.db.run("UPDATE wakeups SET not_before = ?", [Date.now() - 1000]);

  await until(() => wakes(k.db, b.id).every((w) => w.status === "done"));
  const runAccts = k.db
    .query<{ account_id: string | null }, []>("SELECT account_id FROM runs")
    .all();
  expect(runAccts.some((r) => r.account_id === "claude-a")).toBe(true);
});

test("parks at the earliest future reset when beyond 60 seconds", async () => {
  const k = setup();
  const now = Date.now();
  const resetA = now + 180_000;
  seedExhaustedPair(k, resetA, now + 300_000);
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), accountIsolation: true });
  const b = k.agent("bob", [], "claude");
  stops.push(k.start());
  updateTask(k.db, k.task("later").id, { assigneeId: b.id }, k.human.id);
  await until(() => parkedWake(k, b.id)?.not_before !== null);
  expect(parkedWake(k, b.id)?.not_before).toBe(resetA);
});

async function waitParkedRun(
  k: ReturnType<typeof setup>,
  memberId: string,
  expectedRuns: number,
): Promise<number> {
  await until(() => {
    const n = k.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n ?? 0;
    const w = parkedWake(k, memberId);
    return n === expectedRuns && w?.status === "pending" && w.not_before !== null;
  });
  return k.db
    .query<{ exhausted_until: number | null }, []>(
      "SELECT exhausted_until FROM agent_accounts WHERE id = 'claude-only'",
    )
    .get()?.exhausted_until as number;
}

function expectMinutes(untilTs: number, expectedMins: number, before: number): void {
  const mins = (untilTs - before) / 60_000;
  expect(mins).toBeGreaterThanOrEqual(expectedMins - 0.5);
  expect(mins).toBeLessThanOrEqual(expectedMins + 0.5);
}

function expireWait(k: ReturnType<typeof setup>): number {
  const t = Date.now();
  k.db.run("UPDATE agent_accounts SET exhausted_until = ? WHERE id = 'claude-only'", [t - 1000]);
  k.db.run("UPDATE wakeups SET not_before = ?", [t - 1000]);
  return t;
}

test("unprobed reactive rate_limited backs off 15, 30, 60 minutes up to 5h cap and resets after success", async () => {
  const k = setup();
  onlyClaude(k);
  addClaudeAccount(k, "claude-only");
  let mode: "fail" | "ok" = "fail";
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), accountIsolation: true });
  k.runDeps.lane = async () => (mode === "fail" ? rateLimited : ok);

  const b = k.agent("bob", [], "claude");
  stops.push(k.start());
  const task = k.task("retry work");
  updateTask(k.db, task.id, { assigneeId: b.id }, k.human.id);

  let t = Date.now();
  expectMinutes(await waitParkedRun(k, b.id, 1), 15, t);
  t = expireWait(k);
  expectMinutes(await waitParkedRun(k, b.id, 2), 30, t);
  t = expireWait(k);
  expectMinutes(await waitParkedRun(k, b.id, 3), 60, t);

  mode = "ok";
  expireWait(k);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");

  mode = "fail";
  t = Date.now();
  const nextTask = k.task("after recovery");
  updateTask(k.db, nextTask.id, { assigneeId: b.id }, k.human.id);
  expectMinutes(await waitParkedRun(k, b.id, 5), 15, t);
  expect(getTask(k.db, task.id)?.status).not.toBe("blocked");
  expect(getTask(k.db, nextTask.id)?.status).not.toBe("blocked");
});
