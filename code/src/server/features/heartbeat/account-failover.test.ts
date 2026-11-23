import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { updateTask } from "../board/api";
import { startWatchdog } from "../router/api";
import type { RunDeps } from "../runtimes/api";
import { recordQuota } from "../usage/api";
import { setup, specFor, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Outcome = Awaited<ReturnType<NonNullable<RunDeps["lane"]>>>;
const ok: Outcome = { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };

function seedTwoClaudeAccounts(k: ReturnType<typeof setup>, now: number): void {
  for (const id of ["claude-a", "claude-b"]) {
    const dir = join(k.home, "accounts", id);
    mkdirSync(dir, { recursive: true });
    k.db.run(
      `INSERT INTO agent_accounts (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
       VALUES (?, 'claude', 'login', ?, ?, 'active', 2, 1, 1)`,
      [id, id, dir],
    );
  }
  for (const [accountId, usedPercent] of [
    ["claude-a", 10],
    ["claude-b", 60],
  ] as const) {
    recordQuota(k.db, {
      provider: "claude",
      accountId,
      window: "five_hour",
      usedPercent,
      resetsAt: now + 60_000,
      source: "manual",
    });
  }
}

function runRows(k: ReturnType<typeof setup>) {
  return k.db
    .query<
      {
        agent_id: string;
        account_id: string | null;
        attempt: number;
        state: string;
        reason: string | null;
        worktree: string | null;
      },
      []
    >(
      "SELECT agent_id, account_id, attempt, state, reason, worktree FROM runs ORDER BY created_at, rowid",
    )
    .all();
}

test("watchdog 100% on account A fails over to account B of the same runtime in the same worktree", async () => {
  const k = setup();
  const now = Date.now();
  seedTwoClaudeAccounts(k, now);

  const seen: Array<{ cwd: string; prompt: string }> = [];
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), accountIsolation: true });
  k.runDeps.lane = async (ctx) => {
    seen.push({ cwd: ctx.cwd, prompt: ctx.prompt });
    if (seen.length === 1) {
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      return { ...ok, stopReason: "cancelled" };
    }
    return ok;
  };

  const b = k.agent("bob", [], "claude");
  stops.push(startWatchdog(k.db), k.start());
  updateTask(k.db, k.task("work").id, { assigneeId: b.id }, k.human.id);

  await until(() => seen.length === 1);
  recordQuota(k.db, {
    provider: "claude",
    accountId: "claude-a",
    window: "five_hour",
    usedPercent: 100,
    resetsAt: now + 60_000,
    source: "manual",
  });
  await until(() => wakes(k.db, b.id)[0]?.status === "done");

  const runs = runRows(k);
  expect(runs).toMatchObject([
    {
      agent_id: "claude",
      account_id: "claude-a",
      attempt: 1,
      state: "killed",
      reason: "quota_exhausted",
    },
    {
      agent_id: "claude",
      account_id: "claude-b",
      attempt: 2,
      state: "completed",
      worktree: runs[0]?.worktree,
    },
  ]);
  expect(seen[1]?.cwd).toBe(seen[0]?.cwd as string);
  expect(seen[1]?.prompt).toContain("Previous attempt on claude");
});
