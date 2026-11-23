import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import { migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { getSpec, listAccounts } from "../src/server/features/agents/api";
import { addAgentMember, createOrg, createProject } from "../src/server/features/orgs/api";
import { setPolicy } from "../src/server/features/policies/api";
import { attachProfile, createProfile } from "../src/server/features/profiles/api";
import type { RouteDeps } from "../src/server/features/router/api";
import { createCodexProbeLaunch, type RunDeps } from "../src/server/features/runtimes/api";
import { probeAccountQuota, probeQuota } from "../src/server/features/usage/api";
import { type Report, waitFor } from "./gate-5-kit";

export const CANARY = "CANARY_SECRET_G1_9F3A7C44118822";
export const FAKE_BIN: string = resolve(import.meta.dir, "../src/server/test-support/fake-bin");

export type CallFn = (method: string, path: string, body?: unknown) => Promise<Response>;

export interface World {
  orgId: string;
  humanId: string;
  projectId: string;
  workerId: string;
  repo: string;
}

export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Gate",
    GIT_AUTHOR_EMAIL: "g@test",
    GIT_COMMITTER_NAME: "Gate",
    GIT_COMMITTER_EMAIL: "g@test",
  };
  for (const args of [
    ["init", "-b", "main"],
    ["add", "README.md"],
    ["commit", "-m", "init"],
  ]) {
    if (args[0] === "add") writeFileSync(join(dir, "README.md"), "gate repo\n");
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  return dir;
}

export function seedWorld(db: Database, ownerUserId: string, repo: string): World {
  const org = createOrg(db, {
    name: "GateOrg",
    slug: "gateorg",
    ownerUserId,
    ownerName: "Gate Admin",
    ownerHandle: "owner",
  });
  const human = db
    .query<{ id: string }, [string]>("SELECT id FROM members WHERE org_id = ?")
    .get(org.id) as { id: string };
  const project = createProject(db, { orgId: org.id, key: "g1", name: "Gate1", repo });
  const worker = addAgentMember(db, org.id, {
    agentId: "codex",
    model: "gpt-5",
    handle: "codex-worker",
    displayName: "Codex Worker",
    specialties: [],
  });
  const profile = createProfile(db, org.id, {
    runtime: "codex",
    model: "gpt-5",
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(db, worker.id, profile.id);
  setPolicy(db, {
    layer: "org",
    targetId: org.id,
    key: "router.allowedRuntimes",
    value: ["codex"],
    setBy: human.id,
  });
  db.run(
    `INSERT INTO model_registry
       (provider, model_id, name, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok, context_window, tool_call, reasoning, fetched_at)
     VALUES ('openai', 'gpt-5', 'GPT-5', 2, 10, 0.2, 128000, 1, 1, ?)`,
    [Date.now()],
  );
  return { orgId: org.id, humanId: human.id, projectId: project.id, workerId: worker.id, repo };
}

export function makeRunDeps(home: string, port: number, state: { holdNext: boolean }): RunDeps {
  return {
    home,
    port,
    resolveSpec: (id) => {
      const s = getSpec(id);
      return s ? { ...s, accountIsolation: true } : null;
    },
    lane: async (ctx) => {
      if (state.holdNext) {
        state.holdNext = false;
        await new Promise((r) => ctx.signal.addEventListener("abort", r));
        return { stopReason: "cancelled", text: "", usage: [], error: null, sessionId: null };
      }
      return {
        stopReason: "end_turn",
        text: "done",
        usage: [
          {
            model: "gpt-5",
            inputTokens: 500_000,
            outputTokens: 50_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            reportedCostUsd: null,
            source: "acp",
          },
        ],
        error: null,
        sessionId: null,
      };
    },
  };
}

export const codexRouteDeps: RouteDeps = {
  agents: async () => [
    {
      id: "codex",
      name: "Codex",
      lane: "acp" as const,
      installed: true,
      path: join(FAKE_BIN, "codex"),
      version: "0.9.0",
      loggedIn: true,
      error: null,
      canLogin: true,
      enabled: true,
      models: [{ id: "gpt-5", name: "GPT-5" }],
    },
  ],
};

export async function setQuota(
  call: CallFn,
  accountId: string,
  usedPercent: number,
  resetsAt: number,
): Promise<void> {
  const res = await call("POST", "/api/quota", {
    provider: "codex",
    accountId,
    window: "primary",
    usedPercent,
    resetsAt,
  });
  if (res.status !== 200) {
    throw new Error(`POST /api/quota failed: ${res.status} ${await res.text()}`);
  }
}

export async function setupAccounts(
  call: CallFn,
  home: string,
  report: Report,
): Promise<{ acctA: { id: string; home: string }; acctB: { id: string; home: string } }> {
  report.check(
    1,
    (await call("POST", "/api/agents/codex/link", { enabled: true })).status === 200,
    "link codex runtime",
  );
  const addA = await call("POST", "/api/agents/codex/accounts", { label: "alpha" });
  const addB = await call("POST", "/api/agents/codex/accounts", { label: "beta" });
  const acctA = (await addA.json()) as { id: string; home: string };
  const acctB = (await addB.json()) as { id: string; home: string };
  report.check(
    2,
    addA.status === 201 &&
      addB.status === 201 &&
      acctA.home.startsWith(home) &&
      acctB.home.startsWith(home),
    "add two codex accounts via HTTP inside instance home",
  );
  await call("POST", `/api/agents/codex/accounts/${acctA.id}/login`, {});
  await call("POST", `/api/agents/codex/accounts/${acctB.id}/login`, {});
  await waitFor(
    "fake CLI login markers",
    () => existsSync(join(acctA.home, "auth.json")) && existsSync(join(acctB.home, "auth.json")),
  );
  writeFileSync(join(acctA.home, "auth.json"), JSON.stringify({ access_token: CANARY }));
  const testA = (await (
    await call("POST", `/api/agents/codex/accounts/${acctA.id}/test`, {})
  ).json()) as { state: string };
  const testB = (await (
    await call("POST", `/api/agents/codex/accounts/${acctB.id}/test`, {})
  ).json()) as { state: string };
  report.check(
    3,
    testA.state === "active" && testB.state === "active",
    "both accounts test active with fake CLI",
  );
  await call("PATCH", "/api/agents/codex/accounts/default:codex", { enabled: false });
  return { acctA, acctB };
}

// Owner-only live verification (--live): checks two real active Codex accounts in HARNESS_HOME
// for distinct identity hints and a live codex app-server quota read.
export async function runLiveGate(report: Report): Promise<number> {
  const { home } = loadConfig();
  const dbPath = join(home, "harness.db");
  if (!existsSync(dbPath)) {
    report.check(1, false, `live database not found at ${dbPath}`);
    return 1;
  }
  const db = openDb(dbPath);
  try {
    migrate(db, migrations);
    const active = listAccounts(db, "codex").filter(
      (a) => a.state === "active" && a.home !== null && !a.id.startsWith("default:"),
    );
    report.check(1, active.length >= 2, `at least two active Codex accounts (${active.length})`);
    if (active.length < 2) return 1;
    const hints = new Set(active.map((a) => a.identityHint).filter(Boolean));
    report.check(2, hints.size >= 2, `distinct identity hints recorded (${hints.size})`);
    let probed = 0;
    const runDeps: RunDeps = { home, port: 4100 };
    for (const acct of active.slice(0, 2)) {
      const res = await probeAccountQuota(db, acct.id, {
        home,
        launch: (dir, account) => createCodexProbeLaunch(runDeps, dir, account),
      });
      if (res.status === "ok") probed++;
    }
    const rows = (await probeQuota(db)).filter(
      (q) => q.provider === "codex" && q.usedPercent !== null,
    );
    report.check(
      3,
      probed === 2 && rows.length >= 2,
      `live Codex quota probes succeeded (${probed}/2)`,
    );
    return report.failures().length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

export function dumpDiagnostics(db: Database): string {
  return JSON.stringify(
    {
      accounts: db.query("SELECT id, state, home FROM agent_accounts").all(),
      quota: db
        .query("SELECT provider, account_id, window, used_percent FROM quota_snapshots")
        .all(),
      wakes: db.query("SELECT id, task_id, status, not_before, detail FROM wakeups").all(),
      runs: db.query("SELECT id, task_id, account_id, state, reason FROM runs").all(),
      decisions: db.query("SELECT id, chosen_account, candidates_json FROM route_decisions").all(),
      errors: db.query("SELECT kind, source, command FROM events WHERE kind = 'error'").all(),
    },
    null,
    2,
  );
}
