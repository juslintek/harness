// Phase 3 gate: a lead lacks a database specialist, hires one through interviews, delegates to the
// hire, and a simulated quota exhaustion forces a failover to the other runtime. Spends real
// tokens; run through `bun run gate3`, never from `bun test`.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { listAgents } from "../src/server/features/agents/api";
import { createTask, listTasks, onTaskChange, wireBoard } from "../src/server/features/board/api";
import { startBudgets } from "../src/server/features/budgets/api";
import { onMessage, wireChat } from "../src/server/features/chat/api";
import { startHeartbeat } from "../src/server/features/heartbeat/api";
import { startHiring } from "../src/server/features/hiring/api";
import { wireHiring } from "../src/server/features/hiring/wiring";
import { startMemory } from "../src/server/features/memory/api";
import { startRouter } from "../src/server/features/router/api";
import {
  listRuns,
  onRunEvent,
  shutdownRuns,
  wireRuntimes,
} from "../src/server/features/runtimes/api";
import { startTracking } from "../src/server/features/tracking/api";
import { recordQuota } from "../src/server/features/usage/api";
import { createApp } from "../src/server/http";
import { QUOTA_PROVIDER } from "../src/shared/router";
import type { DashboardView } from "../src/shared/tracking";
import {
  build,
  claudeSpendUsd,
  dashboard,
  handoffs,
  hiredMemberId,
  hireStatuses,
  pickLeadModel,
  type Scene,
  writeTimeline,
} from "./gate-3-kit";
import { gateAgentIds } from "./gate-engine";
import { watchLeftovers } from "./smoke-kit";

const WAIT_MS = 40 * 60 * 1000;
const SETTLE_MS = 3 * 60 * 1000;
const MAX_RUNS = 30;
const MAX_CLAUDE_USD = 2.5;
const failures: string[] = [];
const timeline: string[] = [];
const t0 = Date.now();

type Db = ReturnType<typeof openDb>;

function mark(what: string): void {
  const secs = String(Math.round((Date.now() - t0) / 1000)).padStart(4, " ");
  const line = `${secs}s  ${what}`;
  timeline.push(line);
  console.log(line);
}

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(what);
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
}

async function requireLogin(db: Db): Promise<void> {
  const agents = await listAgents(db);
  for (const id of gateAgentIds()) {
    const a = agents.find((x) => x.id === id);
    if (!a?.installed || a.loggedIn !== true) {
      console.error(`FATAL: ${id} is not installed or not logged in (${JSON.stringify(a)})`);
      process.exit(1);
    }
  }
}

async function boot(root: string): Promise<{
  db: Db;
  home: string;
  port: number;
  app: ReturnType<typeof createApp>;
  stop: () => Promise<void>;
}> {
  const home = join(root, "home");
  mkdirSync(home);
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  await requireLogin(db);
  wireBoard(db);
  wireChat(db);
  wireRuntimes();
  const handler: { fetch: (r: Request) => Response | Promise<Response> } = {
    fetch: () => new Response("booting", { status: 503 }),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler.fetch(r) });
  const port = server.port ?? 0;
  const rp = { id: "localhost", name: "Harness", origin: `http://localhost:${port}` };
  const app = createApp({ db, home, port, rp, instanceId, version: "gate3" });
  handler.fetch = app.fetch;
  console.log(`home ${home} (kept for inspection), port ${port}`);
  return { db, home, port, app, stop: async () => void (await server.stop(true)) };
}

function watchTimeline(db: Db, s: Scene): () => void {
  const handles = new Map<string, string>();
  const who = (id: string | null): string => {
    if (id === null) return "?";
    if (!handles.has(id)) {
      const row = db
        .query<{ handle: string }, [string]>("SELECT handle FROM members WHERE id = ?")
        .get(id);
      handles.set(id, row ? `@${row.handle}` : "?");
    }
    return handles.get(id) ?? "?";
  };
  const offs = [
    onTaskChange((c) =>
      mark(
        `task #${c.task.number} ${c.kind} by ${who(c.by)} status=${c.task.status} assignee=${who(c.task.assigneeId)}`,
      ),
    ),
    onMessage((e) => {
      const to = e.mentions.map(who).join(",");
      mark(
        `chat ${e.message.authorId === s.owner ? "gate" : who(e.message.authorId)}${to ? ` -> ${to}` : ""}: ${e.message.body.slice(0, 140).replace(/\s+/g, " ")}`,
      );
    }),
    onRunEvent((runId, e) => {
      if (e.kind === "run") mark(`run ${runId.slice(-6)} ${e.body ?? ""}`.trim());
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

// The simulated probe fires once, on the first run of the hired member, for that run's provider.
function watchHireRun(db: Db, s: Scene): { stop: () => void; injected: () => string | null } {
  let provider: string | null = null;
  let seenStatus = "";
  const timer = setInterval(() => {
    const status = hireStatuses(db, s.orgId).join(",");
    if (status !== seenStatus) mark(`hire requests: ${status || "none"}`);
    seenStatus = status;
    const member = hiredMemberId(db, s.orgId);
    if (provider !== null || member === null) return;
    const run = listRuns(db, 100).find((r) => r.memberId === member && r.state === "running");
    if (!run) return;
    provider = QUOTA_PROVIDER[run.agentId] ?? null;
    if (provider === null) return failures.push(`no quota provider for ${run.agentId}`);
    mark(
      `new member's first run ${run.id.slice(-6)} on ${run.agentId}: injecting 100% ${provider}`,
    );
    recordQuota(db, {
      provider,
      window: "five_hour",
      usedPercent: 100,
      resetsAt: Date.now() + 60 * 60 * 1000,
      source: "manual",
    });
  }, 500);
  return { stop: () => clearInterval(timer), injected: () => provider };
}

function scenarioDone(db: Db, s: Scene): boolean {
  const sub = listTasks(db, s.projectId).find((t) => t.parentId === s.taskId);
  const moved = handoffs(db).some((h) => h.reason === "quota_exhausted" && h.toAgent !== null);
  return (
    hireStatuses(db, s.orgId).includes("hired") &&
    moved &&
    (sub?.status === "in_review" || sub?.status === "done")
  );
}

async function waitFor(db: Db, s: Scene): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (scenarioDone(db, s)) return;
    if (listRuns(db, 200).length > MAX_RUNS) {
      failures.push(`more than ${MAX_RUNS} runs, stopped as a loop`);
      return;
    }
    if (claudeSpendUsd(db) > MAX_CLAUDE_USD) {
      failures.push(`Claude spend passed ${MAX_CLAUDE_USD} USD, aborted`);
      return;
    }
    await Bun.sleep(5000);
  }
  failures.push("timed out waiting for the scenario");
}

function assertOutcome(db: Db, s: Scene, view: DashboardView): void {
  check(hireStatuses(db, s.orgId).includes("hired"), "hire request reached hired");
  const moved = handoffs(db).filter((h) => h.reason === "quota_exhausted");
  check(moved.length > 0, "a run_handoffs row with quota_exhausted exists");
  const next = moved.find((h) => h.toAgent !== null);
  check(
    next !== undefined && next.toAgent !== next.fromAgent,
    "second attempt ran on another runtime",
  );
  check(
    next?.fromWorktree != null && next.fromWorktree === next.toWorktree,
    "second attempt ran in the same worktree",
  );
  check(
    view.members.filter((m) => m.inputTokens + m.outputTokens > 0).length >= 3,
    "dashboard shows tokens for at least 3 agents",
  );
  check(view.members.reduce((n, m) => n + m.wallMs, 0) > 0, "dashboard shows wall time > 0");
  const tasks = listTasks(db, s.projectId);
  const sub = tasks.find((t) => t.parentId === s.taskId);
  const planned = (n: number | undefined): boolean =>
    view.tasks.find((t) => t.number === n)?.plannerMinutes != null;
  check(planned(tasks.find((t) => t.id === s.taskId)?.number), "planner estimate on task #1");
  check(planned(sub?.number), "planner estimate on the subtask");
  check(sub?.status === "in_review" || sub?.status === "done", "subtask reached in_review or done");
}

function printSpend(db: Db, s: Scene, view: DashboardView): void {
  const estimated = view.members.reduce((n, m) => n + m.costUsd, 0);
  console.log(
    `\nspend: Claude reported ${claudeSpendUsd(db).toFixed(4)} USD; all agents ${estimated.toFixed(4)} USD (estimated included)`,
  );
  console.log("\nrun  agent  attempt  state  reason");
  for (const r of listRuns(db, 200).reverse()) {
    const who = r.memberId === s.lead.id ? "@lead" : r.memberId === s.dev.id ? "@dev" : r.agentId;
    console.log(
      `${r.id.slice(-6)}  ${who}/${r.agentId}  ${r.attempt}  ${r.state}  ${r.reason ?? ""}`,
    );
  }
}

async function settle(db: Db): Promise<void> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until && listRuns(db, 200).some((r) => r.endedAt === null)) {
    await Bun.sleep(2000);
  }
}

function assignGateTask(db: Db, s: Scene): void {
  const task = createTask(db, {
    projectId: s.projectId,
    title: "Add a notes migration and helper",
    description:
      "Add a SQL migration `db/001_notes.sql` creating table notes(id, body) and a `db/notes.ts` helper `addNote(body)` with a bun test.",
    assigneeId: s.lead.id,
    createdBy: s.owner,
  });
  s.taskId = task.id;
  mark(`task #${task.number} created and assigned to @lead; no further input from here`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-gate3-"));
  const { db, home, port, app, stop } = await boot(root);
  const runDeps = { home, port };
  const s = build(db, root, await pickLeadModel(db, runDeps));
  const stopTimeline = watchTimeline(db, s);
  const leftovers = watchLeftovers(db, { graceMs: 90_000 });
  const hireRun = watchHireRun(db, s);
  const stopHeartbeat = startHeartbeat(db, { runDeps, home, tickMs: 5000 });
  const hiring = wireHiring(db, { runDeps, home });
  const stopMemory = startMemory(db, { home });
  const stops = [
    ...[startRouter, startBudgets, startTracking].map((start) => start(db)),
    startHiring(db, hiring.deps),
    hiring.stop,
  ];
  try {
    assignGateTask(db, s);
    await waitFor(db, s);
    await settle(db);
  } finally {
    leftovers.stop();
    hireRun.stop();
    const drained = stopHeartbeat();
    for (const off of stops) off();
    stopTimeline();
    await shutdownRuns(db);
    await drained;
    // No API write can arrive once the server is down, so the memory drain sees the last one.
    await stop();
    await stopMemory();
  }
  const view = await dashboard(db, s, app, port);
  assertOutcome(db, s, view);
  printSpend(db, s, view);
  console.log(`\nscript-decided approvals: ${leftovers.decided.length}`);
  for (const line of leftovers.decided) console.log(`  ${line}`);
  writeTimeline(home, timeline);
  db.close();
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\ngate 3 passed (home ${home})`);
}

await main();
