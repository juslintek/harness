import { afterAll, afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRun, killRun, waitForRun } from "../runtimes/api";
import { recordQuota } from "../usage/api";
import { startWatchdog } from "./failover";
import { type Adapter, cleanup, ends, holdUntilKilled, outcome, world } from "./failover-kit";
import { handoffSummary } from "./handoff";

afterAll(cleanup);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("a rate-limit error ends the run failed with reason rate_limited", async () => {
  const w = world();
  const id = await w.start(
    ends({ stopReason: "error", error: "429 Too Many Requests: usage limit" }),
  );
  expect(await waitForRun(id)).toMatchObject({ state: "failed", reason: "rate_limited" });
  const other = await w.start(ends({ stopReason: "error", error: "segfault" }));
  expect(await waitForRun(other)).toMatchObject({ state: "failed", reason: "segfault" });
});

test("recording claude five_hour 100% kills a live claude run and leaves a codex run alone", async () => {
  const w = world();
  stops.push(startWatchdog(w.db));
  const claude = await w.start(holdUntilKilled());
  const codex = await w.start(holdUntilKilled(), { agentId: "codex" });
  recordQuota(w.db, {
    provider: "claude",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: Date.now() + 60_000,
    source: "manual",
  });
  expect(await waitForRun(claude)).toMatchObject({ state: "killed", reason: "quota_exhausted" });
  expect(getRun(w.db, codex)?.state).toBe("running");
  killRun(w.db, codex);
  await waitForRun(codex);
});

test("a stale 100% reading and a lower one leave live runs alone", async () => {
  const w = world();
  stops.push(startWatchdog(w.db));
  const id = await w.start(holdUntilKilled());
  const reading = { provider: "claude", window: "five_hour", source: "manual" };
  recordQuota(w.db, { ...reading, usedPercent: 100, resetsAt: Date.now() - 1000 });
  recordQuota(w.db, { ...reading, usedPercent: 99, resetsAt: Date.now() + 60_000 });
  expect(getRun(w.db, id)?.state).toBe("running");
  killRun(w.db, id);
  await waitForRun(id);
});

test("startRun with reuseWorktreeOf runs in the same directory and branch", async () => {
  const w = world();
  const cwds: string[] = [];
  const first = await w.start(ends({}));
  const done = await waitForRun(first);
  const lane: Adapter = (ctx) => {
    cwds.push(ctx.cwd);
    return Promise.resolve(outcome({}));
  };
  const second = await w.start(lane, { reuseWorktreeOf: first, attempt: 2, batchId: first });
  const row = await waitForRun(second);
  expect(cwds).toEqual([done.worktree as string]);
  expect(row).toMatchObject({
    worktree: done.worktree,
    branch: done.branch,
    attempt: 2,
    batchId: first,
  });
});

test("startRun refuses to reuse a worktree that is gone", async () => {
  const w = world();
  const first = await w.start(ends({}));
  const done = await waitForRun(first);
  rmSync(done.worktree as string, { recursive: true, force: true });
  const second = await w.start(ends({}), { reuseWorktreeOf: first });
  expect(await waitForRun(second)).toMatchObject({ state: "failed", reason: "launch_failed" });
});

test("handoffSummary contains the task number, the stop reason and git status lines", async () => {
  const w = world();
  const id = await w.start(ends({ stopReason: "error", error: "rate limit" }));
  const run = await waitForRun(id);
  writeFileSync(join(run.worktree as string, "scratch.txt"), "half done");
  const text = handoffSummary(w.db, run);
  expect(text).toContain("Task #1 Fix login");
  expect(text).toContain("Previous attempt on claude/opus stopped: failed rate_limited");
  expect(text).toContain("?? scratch.txt");
  expect(text).toContain("do not redo finished steps");
  expect(text.length).toBeLessThanOrEqual(4000);
});
