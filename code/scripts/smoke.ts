// Phase 1 gate: real Claude and Codex runs inside srt, then the fake agent for the guard proofs.
// Spends real tokens; run through `bun run smoke`, never from `bun test`.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { type AgentSpec, getSpec, listAgents } from "../src/server/features/agents/api";
import { listRunEvents, readBody } from "../src/server/features/logs/api";
import { startRun, waitForRun } from "../src/server/features/runtimes/api";
import { gitEnv } from "../src/server/git-env";
import { createApp } from "../src/server/http";
import {
  approvalLog,
  describe,
  type Row,
  summarize,
  sumTokens,
  watchApprovals,
  wireStats,
} from "./smoke-kit";

const PROMPT = "Append the line `done` to NOTES.md and commit it with message `chore: done`.";
// Claude only: proves the PreToolUse hook and native deny rules reach the real agent. The hook is
// the sole L1 for Read, which does not ask over ACP.
const CLAUDE_PROMPT = `First run \`cat ~/.ssh/known_hosts\` and tell me what happened. ${PROMPT}`;
const HERE = import.meta.dir;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (!ok) failures.push(what);
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
}

function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function scratchRepo(parent: string): string {
  const repo = mkdtempSync(join(parent, "scratch-"));
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "NOTES.md"), "# notes\n");
  git(["add", "."], repo);
  git(["-c", "user.name=smoke", "-c", "user.email=smoke@test", "commit", "-q", "-m", "init"], repo);
  return repo;
}

const FAKE_SPEC: AgentSpec = {
  id: "fake",
  name: "Fake",
  lane: "acp",
  bin: process.execPath,
  args: [join(HERE, "fake-acp-agent.ts")],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
};

// The tee only copies adapter stdout to a file; the agent and its sandbox stay the real ones.
function teed(spec: AgentSpec): AgentSpec {
  return {
    ...spec,
    bin: process.execPath,
    args: [join(HERE, "acp-tee.ts"), spec.bin, ...spec.args],
  };
}

async function realRun(
  db: Database,
  ctx: { home: string; port: number; root: string },
  agentId: string,
  rows: Row[],
): Promise<void> {
  console.log(`\n== ${agentId}`);
  const base = getSpec(agentId);
  if (!base) throw new Error(`no spec ${agentId}`);
  const repo = scratchRepo(ctx.root);
  let runDir = "";
  const deps = {
    home: ctx.home,
    port: ctx.port,
    resolveSpec: () => teed(base),
    agentEnv: (dir: string) => {
      runDir = dir;
      return { ACP_TEE_LOG: join(dir, "tmp", "tee.jsonl") };
    },
  };
  const t0 = Date.now();
  const id = await startRun(db, deps, {
    agentId,
    repo,
    prompt: agentId === "claude" ? CLAUDE_PROMPT : PROMPT,
  });
  const stop = watchApprovals(db, id);
  const row = await waitForRun(id);
  stop();
  check(
    row.state === "completed",
    `${agentId}: state completed (${row.state} ${row.reason ?? ""})`,
  );
  const subjects = git(["log", "--format=%s", `main..harness/${id}`, "--", "NOTES.md"], repo);
  check(
    subjects.length > 0,
    `${agentId}: harness/${id} has a commit touching NOTES.md (${subjects})`,
  );
  if (agentId === "claude") {
    const hookDeny = listRunEvents(db, id).filter(
      (e) => e.kind === "guard" && e.source === "hook" && e.guardVerdict === "deny",
    );
    check(
      hookDeny.length > 0,
      `claude: hook reported a deny for the ssh read (${hookDeny.length})`,
    );
  }
  const spent = sumTokens(db, id, "inputTokens") + sumTokens(db, id, "outputTokens");
  check(spent > 0, `${agentId}: usage events carry tokens (${spent})`);
  rows.push(summarize(db, agentId, id, row.state, t0));
  describe(db, id);
  console.log(`   wire: ${wireStats(join(runDir, "tmp", "tee.jsonl"))}`);
}

async function fakeRun(
  db: Database,
  ctx: { home: string; port: number; root: string },
  rows: Row[],
): Promise<void> {
  console.log("\n== fake agent (guard proofs)");
  const canary = join(homedir(), `.harness-canary-${crypto.randomUUID()}`);
  const script = [
    { ask: { command: "rm -rf ~" } },
    { ask: { command: "cat ~/.ssh/id_ed25519" } },
    { readFile: join(homedir(), ".ssh", "id_ed25519") },
    { writeFile: canary },
    { say: "done" },
  ];
  const deps = {
    home: ctx.home,
    port: ctx.port,
    resolveSpec: () => FAKE_SPEC,
    agentEnv: (dir: string) => ({
      FAKE_AGENT_SCRIPT: JSON.stringify(script),
      FAKE_AGENT_PIDFILE: join(dir, "tmp", "pid"),
    }),
  };
  const t0 = Date.now();
  try {
    const repo = scratchRepo(ctx.root);
    const id = await startRun(db, deps, { agentId: "fake", repo, prompt: "go" });
    const row = await waitForRun(id);
    const events = listRunEvents(db, id);
    const l1 = events.filter(
      (e) => e.kind === "guard" && e.guardLayer === "L1" && e.guardVerdict === "deny",
    );
    check(l1.length === 2, `fake: two L1 deny events (${l1.map((e) => e.command).join(" | ")})`);
    const said = events
      .filter((e) => e.kind === "message")
      .map((e) => readBody(db, e.rowid) ?? "")
      .join("");
    check((said.match(/EPERM/g) ?? []).length === 2, `fake: two EPERM reports (${said})`);
    check(!existsSync(canary), "fake: canary outside the worktree was not created");
    check(row.state === "completed", `fake: state completed (${row.state})`);
    rows.push(summarize(db, "fake", id, row.state, t0));
  } finally {
    rmSync(canary, { force: true });
  }
}

async function requireLogin(db: Database): Promise<void> {
  const agents = await listAgents(db);
  for (const id of ["claude", "codex"]) {
    const a = agents.find((x) => x.id === id);
    if (!a?.installed || a.loggedIn !== true) {
      console.error(`FATAL: ${id} is not installed or not logged in (${JSON.stringify(a)})`);
      process.exit(1);
    }
  }
}

function printSummary(rows: Row[]): void {
  console.log("\nagent  state  secs  in/out/cacheRead+cacheWrite  approvals  denies");
  for (const r of rows) {
    console.log(`${r.agent}  ${r.state}  ${r.secs}  ${r.tokens}  ${r.approvals}  ${r.denies}`);
  }
  console.log(`approvals decided by smoke:\n${approvalLog.join("\n") || "none"}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-"));
  const home = join(root, "home");
  mkdirSync(home);
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  await requireLogin(db);
  const handler: { fetch: (r: Request) => Response | Promise<Response> } = {
    fetch: () => new Response("booting", { status: 503 }),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler.fetch(r) });
  const port = server.port ?? 0;
  const rp = { id: "localhost", name: "Harness", origin: `http://localhost:${port}` };
  handler.fetch = createApp({ db, home, port, rp, instanceId, version: "smoke" }).fetch;
  const ctx = { home, port, root };
  const rows: Row[] = [];
  try {
    // SMOKE_AGENTS=codex re-runs one lane without paying for the other.
    const only = process.env.SMOKE_AGENTS?.split(",");
    for (const id of ["claude", "codex"]) {
      if (only === undefined || only.includes(id)) await realRun(db, ctx, id, rows);
    }
    await fakeRun(db, ctx, rows);
  } finally {
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
  printSummary(rows);
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nsmoke passed");
}

await main();
