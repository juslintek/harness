import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { updateTask } from "../board/api";
import { upsertBudget } from "../budgets/api";
import { searchEvents } from "../logs/api";
import { setPolicy } from "../policies/api";
import { attachProfile, createProfile } from "../profiles/api";
import { startWatchdog } from "../router/api";
import { type RunDeps, scratchRepo, setHalted, startRun, waitForRun } from "../runtimes/api";
import { recordQuota, recordUsage } from "../usage/api";
import { wakeNow } from "./api";
import { type Kit, routeDeps, setup, specFor, until, wakes } from "./kit";
import { setStatus } from "./repo";
import { settleRun } from "./settle";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Outcome = Awaited<ReturnType<NonNullable<RunDeps["lane"]>>>;
const ok: Outcome = { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
const rateLimited: Outcome = { ...ok, stopReason: "error", error: "rate limit exceeded" };

interface Attempt {
  engine: string;
  cwd: string;
  prompt: string;
}

// Every run is recorded; `behave` decides how a run on an engine ends.
function lane(k: Kit, behave: (engine: string) => Outcome | "hold"): Attempt[] {
  const attempts: Attempt[] = [];
  k.runDeps.lane = async (ctx) => {
    attempts.push({ engine: ctx.spec.id, cwd: ctx.cwd, prompt: ctx.prompt });
    const outcome = behave(ctx.spec.id);
    if (outcome !== "hold") return outcome;
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
    return { ...ok, stopReason: "cancelled" };
  };
  k.runDeps.resolveSpec = specFor;
  return attempts;
}

function counted(): { agents: number; deps: typeof routeDeps } {
  const calls = { agents: 0, deps: { agents: () => Promise.resolve([]) } as typeof routeDeps };
  calls.deps = {
    agents: () => {
      calls.agents++;
      return routeDeps.agents?.() ?? Promise.resolve([]);
    },
  };
  return calls;
}

const runs = (k: Kit): Record<string, string | number | null>[] =>
  k.db
    .query<Record<string, string | number | null>, []>(
      "SELECT id, agent_id, attempt, batch_id, state, reason, worktree FROM runs ORDER BY created_at, rowid",
    )
    .all();

function assign(k: Kit, memberId: string, title = "t"): string {
  const task = k.task(title);
  updateTask(k.db, task.id, { assigneeId: memberId }, k.human.id);
  return task.id;
}

test("an assignment runs on the engine the router ranks first and stores batch and attempt", async () => {
  const k = setup();
  const attempts = lane(k, () => ok);
  const b = k.agent("bob");
  const profile = createProfile(k.db, k.orgId, {
    runtime: "fake2",
    model: null,
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(k.db, b.id, profile.id);
  stops.push(k.start());
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const [first] = wakes(k.db, b.id);
  const wakeId = k.db.query<{ id: string }, []>("SELECT id FROM wakeups").get()?.id;
  expect(attempts.map((a) => a.engine)).toEqual(["fake2"]);
  expect(runs(k)).toMatchObject([{ agent_id: "fake2", attempt: 1, batch_id: wakeId }]);
  expect(first?.run_id).toBe(runs(k)[0]?.id as string);
});

test("a rate limit moves the wakes to the next engine in the same worktree, with the handoff in its prompt", async () => {
  const k = setup();
  const attempts = lane(k, (engine) => (engine === "fake" ? rateLimited : ok));
  const calls = counted();
  const b = k.agent("bob");
  stops.push(k.start({ routeDeps: calls.deps }));
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const [one, two] = runs(k);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.engine).not.toBe("fake");
  expect(attempts[1]?.cwd).toBe(attempts[0]?.cwd as string);
  expect(attempts[1]?.prompt).toContain("Previous attempt on fake");
  expect(attempts[1]?.prompt).toContain("You were woken because:");
  expect(attempts[1]?.prompt.match(/You were woken because/g)).toHaveLength(1);
  expect(one).toMatchObject({ state: "failed", reason: "rate_limited", attempt: 1 });
  expect(two).toMatchObject({ state: "completed", attempt: 2, batch_id: one?.batch_id });
  expect(wakes(k.db, b.id)[0]?.run_id).toBe(two?.id as string);
  const handoff = k.db.query<{ to_run_id: string }, [string]>(
    "SELECT to_run_id FROM run_handoffs WHERE from_run_id = ?",
  );
  expect(handoff.get(one?.id as string)?.to_run_id).toBe(two?.id as string);
  // Launch routes once and the failed run routes once; the completed second run routes no more.
  expect(calls.agents).toBe(2);
});

test("a quota reading of 100% kills the live run and the work continues on another provider", async () => {
  const k = setup();
  const attempts = lane(k, (engine) => (engine === "claude" ? "hold" : ok));
  const b = k.agent("bob", [], "claude");
  stops.push(startWatchdog(k.db), k.start());
  assign(k, b.id);
  await until(() => attempts.length === 1);
  recordQuota(k.db, {
    provider: "claude",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: Date.now() + 60_000,
    source: "manual",
  });
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const [killed, next] = runs(k);
  expect(killed).toMatchObject({ agent_id: "claude", state: "killed", reason: "quota_exhausted" });
  expect(next).toMatchObject({ state: "completed", attempt: 2 });
  expect(next?.agent_id).not.toBe("claude");
  expect(next?.worktree).toBe(killed?.worktree as string);
});

test("three failing engines give exactly three attempts, each on a new engine, then the wakes fail", async () => {
  const k = setup();
  lane(k, () => rateLimited);
  const calls = counted();
  const b = k.agent("bob");
  stops.push(k.start({ routeDeps: calls.deps }));
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "failed");
  await Bun.sleep(100);
  const all = runs(k);
  expect(all.map((r) => r.attempt)).toEqual([1, 2, 3]);
  expect(new Set(all.map((r) => r.agent_id)).size).toBe(3);
  expect(new Set(all.map((r) => r.batch_id)).size).toBe(1);
  // Launch, then one failover per ended run that may still fail over: attempts 1 and 2.
  expect(calls.agents).toBe(3);
});

test("settling the same ended run again starts nothing and routes nothing", async () => {
  const k = setup();
  lane(k, (engine) => (engine === "fake" ? rateLimited : ok));
  const calls = counted();
  const b = k.agent("bob");
  stops.push(k.start({ routeDeps: calls.deps }));
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const before = calls.agents;
  const first = runs(k)[0]?.id as string;
  await settleRun(k.db, { runDeps: k.runDeps, home: k.home, routeDeps: calls.deps }, first);
  await settleRun(k.db, { runDeps: k.runDeps, home: k.home, routeDeps: calls.deps }, first);
  expect(calls.agents).toBe(before);
  expect(runs(k)).toHaveLength(2);
});

test("a next run that cannot start fails the wakes and nothing loops", async () => {
  const k = setup();
  lane(k, () => rateLimited);
  k.runDeps.resolveSpec = (id) => (id === "fake" ? specFor(id) : null);
  const calls = counted();
  const b = k.agent("bob");
  stops.push(k.start({ routeDeps: calls.deps }));
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "failed");
  await Bun.sleep(100);
  expect(runs(k)).toHaveLength(1);
  expect(wakes(k.db, b.id)[0]?.detail).toContain("unknown agent");
  expect(calls.agents).toBe(2);
  const handoffs = k.db.query<{ to_run_id: string | null }, []>(
    "SELECT to_run_id FROM run_handoffs",
  );
  expect(handoffs.all()).toEqual([{ to_run_id: null }]);
});

test("a harness halted before the failover starts fails the wakes instead of looping", async () => {
  const k = setup();
  const attempts = lane(k, () => rateLimited);
  const b = k.agent("bob");
  const wake = wakeNow(k.db, b.id, "user:u1");
  const runId = await startRun(k.db, k.runDeps, {
    agentId: "fake",
    repo: scratchRepo(k.home, k.orgId),
    prompt: "go",
    member: { memberId: b.id, orgId: k.orgId, scopes: [] },
  });
  setStatus(k.db, [wake], "started", { runId });
  await waitForRun(runId);
  setHalted(k.db, true);
  await settleRun(k.db, { runDeps: k.runDeps, home: k.home, routeDeps }, runId);
  expect(attempts).toHaveLength(1);
  expect(runs(k)).toHaveLength(1);
  expect(wakes(k.db, b.id)[0]).toMatchObject({ status: "failed" });
  expect(wakes(k.db, b.id)[0]?.detail).toContain("halted");
});

test("a policy that turns failover off leaves the failed run's wakes failed", async () => {
  const k = setup();
  const attempts = lane(k, () => rateLimited);
  const b = k.agent("bob");
  setPolicy(k.db, {
    layer: "org",
    targetId: k.orgId,
    key: "router.failover",
    value: false,
    setBy: "t",
  });
  stops.push(k.start());
  assign(k, b.id);
  await until(() => wakes(k.db, b.id)[0]?.status === "failed");
  expect(attempts).toHaveLength(1);
});

function spendOver(k: Kit, memberId: string): void {
  upsertBudget(k.db, k.orgId, { scopeKind: "member", scopeId: memberId, monthlyUsd: 1 }, "owner");
  const run = Bun.randomUUIDv7();
  k.db.run(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, member_id) VALUES (?, 'fake', '/r', 'p', 'completed', ?, ?)",
    [run, Date.now(), memberId],
  );
  recordUsage(k.db, { id: run, agent: "fake" }, [
    {
      model: "m",
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reportedCostUsd: 5,
      source: "acp",
    },
  ]);
}

test("a paused budget skips the wakes without a run and logs once per hour", async () => {
  const k = setup();
  const attempts = lane(k, () => ok);
  const b = k.agent("bob");
  spendOver(k, b.id);
  stops.push(k.start());
  assign(k, b.id, "one");
  await until(() => wakes(k.db, b.id)[0]?.status === "skipped");
  assign(k, b.id, "two");
  await until(() => wakes(k.db, b.id).length === 2 && wakes(k.db, b.id)[1]?.status === "skipped");
  expect(wakes(k.db, b.id).map((w) => JSON.parse(w.detail as string))).toEqual([
    { budget: "paused" },
    { budget: "paused" },
  ]);
  expect(attempts).toHaveLength(0);
  expect(searchEvents(k.db, "spent")).toHaveLength(1);
});

test("heartbeat.maxRunsPerHour from policy caps the runs", async () => {
  const k = setup();
  lane(k, () => ok);
  const b = k.agent("bob");
  setPolicy(k.db, {
    layer: "org",
    targetId: k.orgId,
    key: "heartbeat.maxRunsPerHour",
    value: 1,
    setBy: "t",
  });
  stops.push(k.start());
  assign(k, b.id, "one");
  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  assign(k, b.id, "two");
  await until(() => wakes(k.db, b.id).length === 2);
  expect(wakes(k.db, b.id)[1]).toMatchObject({ status: "skipped" });
  expect(wakes(k.db, b.id)[1]?.detail).toContain("hourly");
  expect(runs(k)).toHaveLength(1);
  expect(() => wakeNow(k.db, b.id, "user:u1")).toThrow("wake_cap");
});
