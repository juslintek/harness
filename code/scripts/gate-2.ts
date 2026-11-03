// Phase 2 gate: a Claude lead and a Codex dev coordinate through the board and chat with no input
// after the first task. Spends real tokens; run through `bun run gate2`, never from `bun test`.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { listAgents } from "../src/server/features/agents/api";
import { createTask, listTasks, onTaskChange, wireBoard } from "../src/server/features/board/api";
import { listMessages, onMessage, wireChat } from "../src/server/features/chat/api";
import { listWakeups, startHeartbeat } from "../src/server/features/heartbeat/api";
import type { MemberRow } from "../src/server/features/orgs/api";
import { listRuns, onRunEvent, shutdownRuns } from "../src/server/features/runtimes/api";
import { createApp } from "../src/server/http";
import { build, git, type Scene } from "./gate-2-kit";
import { sumTokens, watchLeftovers } from "./smoke-kit";

const WAIT_MS = 30 * 60 * 1000;
const SETTLE_MS = 3 * 60 * 1000;
const MAX_RUNS = 20;
const failures: string[] = [];
let devCheckedOut = false;
const timeline: string[] = [];
const t0 = Date.now();

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

async function requireLogin(db: ReturnType<typeof openDb>): Promise<void> {
  const agents = await listAgents(db);
  for (const id of ["claude", "codex"]) {
    const a = agents.find((x) => x.id === id);
    if (!a?.installed || a.loggedIn !== true) {
      console.error(`FATAL: ${id} is not installed or not logged in (${JSON.stringify(a)})`);
      process.exit(1);
    }
  }
}

type Db = ReturnType<typeof openDb>;

function watchTimeline(s: Scene): () => void {
  const who = (id: string | null): string =>
    id === s.lead.id ? "@lead" : id === s.dev.id ? "@dev" : id === s.owner.id ? "gate" : "?";
  const offs = [
    onTaskChange((c) => {
      if (c.kind === "checked_out" && c.by === s.dev.id) devCheckedOut = true;
      mark(
        `task #${c.task.number} ${c.kind} by ${who(c.by)} status=${c.task.status} assignee=${who(c.task.assigneeId)}`,
      );
    }),
    onMessage((e) => {
      const to = e.mentions.map(who).join(",");
      mark(
        `chat ${who(e.message.authorId)}${to ? ` -> ${to}` : ""}: ${e.message.body.slice(0, 140).replace(/\s+/g, " ")}`,
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

// Only the dev's own run branches count: the lead wrote the code itself in an earlier attempt.
function branchesWithAdd(db: Db, s: Scene): string[] {
  const own = db
    .query<{ branch: string }, [string]>(
      "SELECT DISTINCT branch FROM runs WHERE member_id = ? AND branch IS NOT NULL",
    )
    .all(s.dev.id);
  return own
    .map((r) => r.branch)
    .filter((b) => {
      if (
        Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", b], { cwd: s.repo }).exitCode !==
        0
      )
        return false;
      const ahead = git(["rev-list", "--count", `main..${b}`], s.repo) !== "0";
      return ahead && git(["show", `${b}:math.ts`], s.repo).includes("add");
    });
}

function state(db: Db, s: Scene): Record<string, boolean> {
  const tasks = listTasks(db, s.projectId);
  const parent = tasks.find((t) => t.id === s.taskId);
  const sub = tasks.find((t) => t.parentId === s.taskId);
  const msgs = listMessages(db, s.channelId, s.owner.id, { limit: 200 });
  const from = (m: MemberRow): typeof msgs => msgs.filter((x) => x.authorId === m.id);
  return {
    subtaskForDev: sub?.assigneeId === s.dev.id,
    devCheckout: tasks.some((t) => t.holderId === s.dev.id) || devCheckedOut,
    devBranchWithAdd: branchesWithAdd(db, s).length > 0,
    leadMessage: from(s.lead).length > 0,
    devMessage: from(s.dev).length > 0,
    mention: msgs.some(
      (m) =>
        (m.authorId === s.lead.id && m.mentions.includes(s.dev.id)) ||
        (m.authorId === s.dev.id && m.mentions.includes(s.lead.id)),
    ),
    parentDone: parent?.status === "done",
    subtaskDone: sub?.status === "done",
  };
}

async function waitFor(db: Db, done: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (done()) return;
    if (listRuns(db, 100).length > MAX_RUNS) {
      failures.push(`more than ${MAX_RUNS} runs, stopped as a loop`);
      return;
    }
    await Bun.sleep(5000);
  }
  failures.push("timed out waiting for the scenario");
}

function totals(db: Db, s: Scene): void {
  console.log("\nrun  agent  state  in/out/cacheRead+cacheWrite  reason");
  for (const r of listRuns(db, 100).reverse()) {
    const t = (
      k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
    ): number => sumTokens(db, r.id, k);
    const who = r.memberId === s.lead.id ? "@lead" : r.memberId === s.dev.id ? "@dev" : r.agentId;
    console.log(
      `${r.id.slice(-6)}  ${who}  ${r.state}  ${t("inputTokens")}/${t("outputTokens")}/${t("cacheReadTokens")}+${t("cacheWriteTokens")}  ${r.reason ?? ""}`,
    );
  }
}

async function boot(
  root: string,
): Promise<{ db: Db; home: string; port: number; stop: () => Promise<void> }> {
  const home = join(root, "home");
  mkdirSync(home);
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  await requireLogin(db);
  wireBoard(db);
  wireChat(db);
  const handler: { fetch: (r: Request) => Response | Promise<Response> } = {
    fetch: () => new Response("booting", { status: 503 }),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler.fetch(r) });
  const port = server.port ?? 0;
  const rp = { id: "localhost", name: "Harness", origin: `http://localhost:${port}` };
  handler.fetch = createApp({ db, home, port, rp, instanceId, version: "gate2" }).fetch;
  console.log(`home ${home} (kept for inspection), port ${port}`);
  return { db, home, port, stop: async () => void (await server.stop(true)) };
}

function report(db: Db, s: Scene, home: string): void {
  for (const [what, ok] of Object.entries(state(db, s))) check(ok, what);
  console.log("\nwakeups:");
  for (const w of listWakeups(db, s.orgId, 100, s.owner.id).reverse()) {
    const who = w.memberId === s.lead.id ? "@lead" : "@dev";
    console.log(
      `  ${w.reason} ${who} task=${w.taskNumber ?? "-"} ${w.status} run=${w.runId?.slice(-6) ?? "-"}`,
    );
  }
  totals(db, s);
  writeFileSync(join(home, "timeline.txt"), `${timeline.join("\n")}\n`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-gate2-"));
  const { db, home, port, stop } = await boot(root);
  const s = build(db, root);
  const stopTimeline = watchTimeline(s);
  const leftovers = watchLeftovers(db, { graceMs: 90_000 });
  const stopHeartbeat = startHeartbeat(db, { runDeps: { home, port }, home, tickMs: 5000 });
  try {
    const task = createTask(db, {
      projectId: s.projectId,
      title: "Add `add(a, b)` to math.ts with a bun test",
      description:
        "Split this into a subtask for @dev, follow the work in the GATE project channel, review @dev's branch and move both tasks to done when the test passes.",
      assigneeId: s.lead.id,
      createdBy: s.owner.id,
    });
    s.taskId = task.id;
    mark(`task #${task.number} created and assigned to @lead; no further input from here`);
    await waitFor(db, () => Object.values(state(db, s)).every(Boolean));
    // Let the last runs finish so their usage lands in the totals.
    const settle = Date.now() + SETTLE_MS;
    while (Date.now() < settle && listRuns(db, 100).some((r) => r.endedAt === null)) {
      await Bun.sleep(2000);
    }
  } finally {
    leftovers.stop();
    stopHeartbeat();
    stopTimeline();
    await shutdownRuns(db);
    await stop();
  }
  report(db, s, home);
  console.log(`script-decided approvals: ${leftovers.decided.length}`);
  for (const line of leftovers.decided) console.log(`  ${line}`);
  db.close();
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\ngate 2 passed (home ${home})`);
}

await main();
