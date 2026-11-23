import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { updateTask } from "../board/api";
import { setPolicy } from "../policies/api";
import type { RunDeps } from "../runtimes/api";
import { nextBatch } from "./executor";
import { setup, specFor, until, wakes } from "./kit";

setDefaultTimeout(30_000);

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

type Outcome = Awaited<ReturnType<NonNullable<RunDeps["lane"]>>>;
const ok: Outcome = { stopReason: "end_turn", text: "", usage: [], error: null, sessionId: null };
const rateLimited: Outcome = { ...ok, stopReason: "error", error: "429 rate limit exceeded" };

function addClaude(k: ReturnType<typeof setup>, id: string): string {
  const dir = join(k.home, "accounts", id);
  mkdirSync(dir, { recursive: true });
  k.db.run(
    `INSERT INTO agent_accounts (id, runtime, kind, label, home, state, max_concurrent, created_at, updated_at)
     VALUES (?, 'claude', 'login', ?, ?, 'active', 2, 1, 1)`,
    [id, id, dir],
  );
  return dir;
}

test("resumed parked wake starts a fresh failover batch so recovered accounts can fail over again", async () => {
  const k = setup();
  setPolicy(k.db, {
    layer: "org",
    targetId: k.orgId,
    key: "router.allowedRuntimes",
    value: ["claude"],
    setBy: k.human.id,
  });
  const dirA = addClaude(k, "claude-a");
  addClaude(k, "claude-b");
  let phase: "exhaust" | "recover" = "exhaust";
  const seen: string[] = [];
  k.runDeps.resolveSpec = (id) => ({ ...specFor(id), accountIsolation: true });
  k.runDeps.lane = async (ctx) => {
    const dir = ctx.env.CLAUDE_CONFIG_DIR ?? "";
    seen.push(dir);
    if (phase === "exhaust") return rateLimited;
    // After recovery, the first account fails again; failover must still reach the other recovered account.
    return dir === dirA ? rateLimited : ok;
  };
  const b = k.agent("bob", [], "claude");
  stops.push(k.start());
  updateTask(k.db, k.task("recover failover").id, { assigneeId: b.id }, k.human.id);

  await until(() => {
    const n = k.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n ?? 0;
    const w = k.db
      .query<{ status: string; not_before: number | null }, [string]>(
        "SELECT status, not_before FROM wakeups WHERE member_id = ? LIMIT 1",
      )
      .get(b.id);
    return n === 2 && w?.status === "pending" && w.not_before !== null;
  });

  phase = "recover";
  const past = Date.now() - 1000;
  k.db.run("UPDATE agent_accounts SET exhausted_until = ?", [past]);
  k.db.run("UPDATE wakeups SET not_before = ?", [past]);

  await until(() => wakes(k.db, b.id)[0]?.status === "done");
  const batches = k.db.query<{ batch_id: string }, []>("SELECT DISTINCT batch_id FROM runs").all();
  expect(batches).toHaveLength(2);
  expect(seen.length).toBeGreaterThanOrEqual(3);
});

test("nextBatch keeps wakes with different parkedFromRunId continuations in separate batches", () => {
  const k = setup();
  const b = k.agent("bob", [], "claude");
  const t1 = k.task("one");
  const t2 = k.task("two");
  const t3 = k.task("three");
  for (const t of [t1, t2, t3]) updateTask(k.db, t.id, { assigneeId: b.id }, k.human.id);
  const rows = k.db
    .query<{ id: string }, [string]>("SELECT id FROM wakeups WHERE member_id = ? ORDER BY rowid")
    .all(b.id);
  k.db.run("UPDATE wakeups SET detail = ? WHERE id = ?", [
    JSON.stringify({ route: "pool_exhausted", parkedFromRunId: "run-1" }),
    rows[0]?.id as string,
  ]);
  k.db.run("UPDATE wakeups SET detail = ? WHERE id = ?", [
    JSON.stringify({ route: "pool_exhausted", parkedFromRunId: "run-2" }),
    rows[1]?.id as string,
  ]);
  k.db.run("UPDATE wakeups SET detail = ? WHERE id = ?", [
    JSON.stringify({ route: "pool_exhausted", parkedFromRunId: "run-1" }),
    rows[2]?.id as string,
  ]);

  const batch = nextBatch(k.db, b.id);
  expect(batch.wakes.map((w) => w.id)).toEqual([rows[0]?.id as string, rows[2]?.id as string]);
});
