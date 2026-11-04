// Phase 4 gate: a Claude agent writes down a house rule as a lesson after its task, the manager
// accepts it, and a Codex agent on a later task that never mentions the rule follows it because
// it read the note. Spends real tokens; run through `bun run gate4`, never from `bun test`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, getTask, moveTask } from "../src/server/features/board/api";
import { startBudgets } from "../src/server/features/budgets/api";
import { startHeartbeat } from "../src/server/features/heartbeat/api";
import { startHiring } from "../src/server/features/hiring/api";
import { wireHiring } from "../src/server/features/hiring/wiring";
import { startMemory } from "../src/server/features/memory/api";
import { startRouter } from "../src/server/features/router/api";
import { listRuns, shutdownRuns } from "../src/server/features/runtimes/api";
import { startTracking } from "../src/server/features/tracking/api";
import { claudeSpendUsd, pickLeadModel } from "./gate-3-kit";
import {
  acceptedLesson,
  assertOutcome,
  branchWith,
  dumpMemoryState,
  hasLiveRun,
} from "./gate-4-checks";
import {
  boot,
  build,
  check,
  type Db,
  failures,
  mark,
  results,
  type Scene,
  watchTimeline,
  writeTimeline,
} from "./gate-4-kit";
import { watchLeftovers } from "./smoke-kit";

const WAIT_MS = 40 * 60 * 1000;
const LESSON_WAIT_MS = 15 * 60 * 1000;
const SETTLE_MS = 3 * 60 * 1000;
const MAX_RUNS = 20;
const MAX_CLAUDE_USD = 2.0;

// A reason to stop waiting, or null while the scenario is inside its caps.
function overCap(db: Db, deadline: number): string | null {
  if (Date.now() > deadline) return "timed out waiting for the scenario";
  if (listRuns(db, 200).length > MAX_RUNS) return `more than ${MAX_RUNS} runs, stopped as a loop`;
  if (claudeSpendUsd(db) > MAX_CLAUDE_USD) return `Claude spend passed ${MAX_CLAUDE_USD} USD`;
  return null;
}

// The script closes A only once nobody is working on it and the file exists on dev's own branch;
// the retro is what the gate is after, and it fires on the move to done.
function closeTaskA(db: Db, s: Scene, taskA: string): boolean {
  const task = getTask(db, taskA);
  if (task?.status === "done") return true;
  if (hasLiveRun(db, s.dev.id) || branchWith(db, s, s.dev.id, "src/slug.js") === null) return false;
  const moved = moveTask(db, taskA, "done", task?.holderId ?? s.owner);
  if (!moved.ok) mark(`gate could not move task A to done: ${moved.reason}`);
  else mark("gate moved task A to done, dev's branch has src/slug.js");
  return moved.ok;
}

async function waitForLesson(db: Db, home: string, s: Scene, taskA: string): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  let doneAt: number | null = null;
  for (;;) {
    if (acceptedLesson(db, home, s) !== null) return true;
    const stop = overCap(db, deadline);
    if (stop !== null) {
      failures.push(stop);
      return false;
    }
    if (doneAt === null && closeTaskA(db, s, taskA)) doneAt = Date.now();
    if (doneAt !== null && Date.now() - doneAt > LESSON_WAIT_MS) {
      failures.push("no accepted lesson with the rule within 15 min of task A done");
      dumpMemoryState(db, s);
      return false;
    }
    await Bun.sleep(5000);
  }
}

function taskBFinished(db: Db, s: Scene, taskB: string): boolean {
  const status = getTask(db, taskB)?.status;
  const landed = status === "in_review" || status === "done";
  return (
    (landed || branchWith(db, s, s.dev2.id, "src/clamp.js") !== null) && !hasLiveRun(db, s.dev2.id)
  );
}

async function waitForTaskB(db: Db, s: Scene, taskB: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!taskBFinished(db, s, taskB)) {
    const stop = overCap(db, deadline);
    if (stop !== null) {
      failures.push(stop);
      return;
    }
    await Bun.sleep(5000);
  }
}

async function settle(db: Db): Promise<void> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until && listRuns(db, 200).some((r) => r.endedAt === null)) {
    await Bun.sleep(2000);
  }
}

function createTaskA(db: Db, s: Scene): string {
  const task = createTask(db, {
    projectId: s.projectId,
    title: "Add a slugify helper",
    description:
      "Add `src/slug.js` exporting `slugify(text)`. House rule from the reviewer: every new source file must start with the line `// owner: team-larch-7`.",
    assigneeId: s.dev.id,
    createdBy: s.owner,
  });
  mark(`task #${task.number} (A) created and assigned to @dev`);
  return task.id;
}

// No mention of the rule: the only way @dev2 can know it is the memory the harness serves.
function createTaskB(db: Db, s: Scene): string {
  const task = createTask(db, {
    projectId: s.projectId,
    title: "Add a clamp helper",
    description: "Add `src/clamp.js` exporting `clamp(n, min, max)`.",
    assigneeId: s.dev2.id,
    createdBy: s.owner,
  });
  mark(`task #${task.number} (B) created and assigned to @dev2, no mention of the rule`);
  return task.id;
}

function printSummary(db: Db, s: Scene, home: string, approvals: string[]): void {
  const passed = results.filter((r) => r.startsWith("PASS")).length;
  console.log(`\n${passed}/${results.length} assertions passed`);
  console.log(`Claude spend: ${claudeSpendUsd(db).toFixed(4)} USD (cap ${MAX_CLAUDE_USD})`);
  const who = new Map([s.lead, s.dev, s.dev2].map((m) => [m.id, `@${m.handle}`]));
  console.log("\nrun  member  agent  attempt  state  reason");
  for (const r of listRuns(db, 200).reverse()) {
    const row = [r.id.slice(-6), who.get(r.memberId ?? "") ?? "?", r.agentId, r.attempt, r.state];
    console.log(`${row.join("  ")}  ${r.reason ?? ""}`);
  }
  console.log(`\nscript-decided approvals: ${approvals.length}`);
  for (const line of approvals) console.log(`  ${line}`);
  console.log(`\nhome (kept): ${home}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-gate4-"));
  const { db, home, port, stop } = await boot(root);
  const runDeps = { home, port };
  const s = build(db, root, await pickLeadModel(db, runDeps));
  const stopTimeline = watchTimeline(db, s);
  const leftovers = watchLeftovers(db, { graceMs: 90_000 });
  const stopHeartbeat = startHeartbeat(db, { runDeps, home, tickMs: 5000 });
  const hiring = wireHiring(db, { runDeps, home });
  const stopMemory = startMemory(db, { home });
  const stops = [
    ...[startRouter, startBudgets, startTracking].map((start) => start(db)),
    startHiring(db, hiring.deps),
    hiring.stop,
  ];
  let taskA = "";
  let taskB: string | null = null;
  try {
    taskA = createTaskA(db, s);
    if (await waitForLesson(db, home, s, taskA)) {
      mark("lesson accepted by @lead and its note is in the project or org scope");
      taskB = createTaskB(db, s);
      await waitForTaskB(db, s, taskB);
    }
    await settle(db);
  } finally {
    leftovers.stop();
    const drained = stopHeartbeat();
    for (const off of stops) off();
    stopTimeline();
    await shutdownRuns(db);
    await drained;
    await stopMemory();
  }
  await stop();
  if (taskB !== null) assertOutcome(db, s, home, taskA, taskB);
  check(claudeSpendUsd(db) <= MAX_CLAUDE_USD, `8 Claude spend is at most ${MAX_CLAUDE_USD} USD`);
  printSummary(db, s, home, leftovers.decided);
  writeTimeline(home);
  db.close();
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\ngate 4 passed");
}

await main();
