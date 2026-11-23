import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createTask, getTask, updateTask } from "../src/server/features/board/api";
import { readBody } from "../src/server/features/logs/api";
import {
  getRun,
  killRun,
  type RunDeps,
  startRun,
  waitForRun,
} from "../src/server/features/runtimes/api";
import type { Notification } from "../src/shared/notify";
import { type Instance, type Report, waitFor } from "./gate-5-kit";
import { CANARY, type CallFn, setQuota, type World } from "./gate-accounts-kit";

export async function verifyRoutingAndUsage(
  db: Database,
  world: World,
  call: CallFn,
  acctA: { id: string },
  acctB: { id: string },
  report: Report,
): Promise<void> {
  const future = Date.now() + 3_600_000;
  await setQuota(call, acctA.id, 75, future);
  await setQuota(call, acctB.id, 15, future);
  const t1 = createTask(db, {
    projectId: world.projectId,
    title: "Spread task",
    createdBy: world.humanId,
  });
  updateTask(db, t1.id, { assigneeId: world.workerId }, world.humanId);
  await waitFor(
    "first run completion",
    () =>
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE state = 'completed'").get()
        ?.n === 1,
    10_000,
  );
  const run1 = db
    .query<{ id: string; account_id: string }, []>(
      "SELECT id, account_id FROM runs ORDER BY created_at LIMIT 1",
    )
    .get();
  report.check(
    4,
    run1?.account_id === acctB.id,
    `spread chose lower-usage account (${run1?.account_id})`,
  );

  const decisions = (await (await call("GET", "/api/router/decisions?limit=5")).json()) as Array<{
    chosenAccount: string | null;
    runId: string | null;
  }>;
  report.check(
    5,
    decisions.some((d) => d.chosenAccount === acctB.id && d.runId === run1?.id),
    "route decision logged and linked to run",
  );
  const usageB = (await (
    await call("GET", `/api/agents/codex/accounts/${acctB.id}/usage`)
  ).json()) as { totals: { inputTokens: number; estimatedCostUsd: number } };
  report.check(
    6,
    usageB.totals.inputTokens === 500_000 && Math.abs(usageB.totals.estimatedCostUsd - 1.5) < 0.01,
    "usage attributed to beta in tokens and API-equivalent USD",
  );
}

async function startBystander(
  db: Database,
  runDeps: RunDeps,
  repo: string,
  accountId: string,
): Promise<string> {
  const id = await startRun(
    db,
    {
      ...runDeps,
      lane: async (ctx) => {
        await new Promise((r) => ctx.signal.addEventListener("abort", r));
        return { stopReason: "cancelled", text: "", usage: [], error: null, sessionId: null };
      },
    },
    { agentId: "codex", accountId, repo, prompt: "bystander" },
  );
  await waitFor("bystander running", () => getRun(db, id)?.state === "running");
  return id;
}

export async function verifyFailoverAndWatchdog(
  db: Database,
  world: World,
  call: CallFn,
  runDeps: RunDeps,
  state: { holdNext: boolean },
  acctA: { id: string },
  acctB: { id: string },
  report: Report,
): Promise<void> {
  const future = Date.now() + 3_600_000;
  await setQuota(call, acctA.id, 10, future);
  await setQuota(call, acctB.id, 50, future);
  const bystander = await startBystander(db, runDeps, world.repo, acctB.id);
  db.run("UPDATE agent_accounts SET max_concurrent = 2 WHERE id = ?", [acctB.id]);
  state.holdNext = true;
  const t2 = createTask(db, {
    projectId: world.projectId,
    title: "Failover task",
    createdBy: world.humanId,
  });
  updateTask(db, t2.id, { assigneeId: world.workerId }, world.humanId);
  await waitFor(
    "failover attempt 1 running",
    () =>
      db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM runs WHERE task_id = ? AND state = 'running'",
        )
        .get(t2.id)?.n === 1,
  );
  await setQuota(call, acctA.id, 100, future);
  await waitFor(
    "failover wake done",
    () =>
      db
        .query<{ status: string }, [string]>("SELECT status FROM wakeups WHERE task_id = ?")
        .get(t2.id)?.status === "done",
  );
  const runs = db
    .query<
      { account_id: string; state: string; reason: string | null; worktree: string | null },
      [string]
    >("SELECT account_id, state, reason, worktree FROM runs WHERE task_id = ? ORDER BY attempt")
    .all(t2.id);
  const ok =
    runs.length === 2 &&
    runs[0]?.account_id === acctA.id &&
    runs[0]?.reason === "quota_exhausted" &&
    runs[1]?.account_id === acctB.id &&
    runs[1]?.state === "completed" &&
    runs[0]?.worktree === runs[1]?.worktree;
  report.check(7, ok, "watchdog killed alpha and failover completed on beta in same worktree");
  report.check(
    8,
    getRun(db, bystander)?.state === "running",
    "watchdog left concurrent beta run alive",
  );
  killRun(db, bystander);
  await waitForRun(bystander);
}

export async function verifyParkAndRemove(
  inst: Instance,
  world: World,
  call: CallFn,
  acctA: { id: string; home: string },
  acctB: { id: string },
  defaultCodex: string,
  notices: Notification[],
  report: Report,
): Promise<void> {
  const future = Date.now() + 3_600_000;
  await setQuota(call, acctB.id, 100, future);
  const t3 = createTask(inst.db, {
    projectId: world.projectId,
    title: "Parked task",
    createdBy: world.humanId,
  });
  updateTask(inst.db, t3.id, { assigneeId: world.workerId }, world.humanId);
  const parked = await waitFor("parked wake", () => {
    const w = inst.db
      .query<{ status: string; not_before: number | null }, [string]>(
        "SELECT status, not_before FROM wakeups WHERE task_id = ?",
      )
      .get(t3.id);
    return w?.status === "pending" && w.not_before !== null ? w : null;
  });
  report.check(
    9,
    (parked.not_before ?? 0) >= Date.now() + 55_000 &&
      getTask(inst.db, t3.id)?.status !== "blocked" &&
      notices.filter((n) => n.kind === "pool_exhausted").length === 1,
    "all-exhausted pool parks wake without blocking task and notifies once",
  );
  const rmA = await call("DELETE", `/api/agents/codex/accounts/${acctA.id}`);
  const rmDef = await call("DELETE", "/api/agents/codex/accounts/default:codex");
  report.check(
    10,
    rmA.status === 200 &&
      !existsSync(acctA.home) &&
      rmDef.status >= 400 &&
      existsSync(defaultCodex),
    "remove deletes account directory and leaves default account intact",
  );
}

export async function verifyCanary(
  inst: Instance,
  call: CallFn,
  removedId: string,
  report: Report,
): Promise<void> {
  const eventBodies = inst.db
    .query<{ rowid: number }, []>("SELECT rowid FROM events")
    .all()
    .map((r) => readBody(inst.db, r.rowid) ?? "");
  const dumpParts = [
    ...eventBodies,
    JSON.stringify(inst.db.query("SELECT * FROM events").all()),
    JSON.stringify(inst.db.query("SELECT * FROM route_decisions").all()),
    await (await call("GET", `/api/search?q=${encodeURIComponent(CANARY)}`)).text(),
    await (await call("GET", "/api/agents")).text(),
    await (await call("GET", "/api/agents/codex/accounts")).text(),
    await (await call("GET", "/api/quota")).text(),
    await (await call("GET", "/api/router/decisions")).text(),
    await (await call("GET", "/api/runs")).text(),
    await (await call("GET", `/api/agents/codex/accounts/${removedId}/usage`)).text(),
  ];
  report.check(
    11,
    dumpParts.every((p) => !p.includes(CANARY)),
    "canary credential string absent from segments, events, search, decisions, and API outputs",
  );
}
