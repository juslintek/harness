import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { gitEnv } from "../../git-env";
import type { AgentSpec } from "../agents/api";
import { createTask } from "../board/api";
import { addAgentMember, createOrg, createProject } from "../orgs/api";
import { attachProfile, createProfile } from "../profiles/api";
import { type RunDeps, startRun } from "../runtimes/api";
import type { RouteDeps } from "./candidates";

export type Adapter = NonNullable<RunDeps["lane"]>;
export type RunOutcome = Awaited<ReturnType<Adapter>>;

const dirs: string[] = [];

export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function initRepo(repo: string): void {
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "a");
  const who = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const steps = [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    [...who, "commit", "-qm", "init"],
  ];
  for (const args of steps) {
    const res = Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv() });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  }
}

const specOf = (id: string): AgentSpec => ({
  id,
  name: id,
  lane: "acp",
  bin: "",
  args: [],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
});

export const outcome = (over: Partial<RunOutcome>): RunOutcome => ({
  stopReason: "end_turn",
  text: "",
  usage: [],
  error: null,
  sessionId: null,
  ...over,
});

export const ends =
  (over: Partial<RunOutcome>): Adapter =>
  () =>
    Promise.resolve(outcome(over));

export function holdUntilKilled(): Adapter {
  return (ctx) =>
    new Promise((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(outcome({ stopReason: "cancelled" }))),
    );
}

export const agents = (...ids: string[]): RouteDeps => ({
  agents: () =>
    Promise.resolve(
      ids.map((id) => ({
        id,
        name: id,
        lane: "acp" as const,
        installed: true,
        path: null,
        version: null,
        loggedIn: true,
        error: null,
        canLogin: true,
        enabled: true,
        models: [],
      })),
    ),
});

export interface World {
  db: Database;
  repo: string;
  memberId: string;
  taskId: string;
  start: (
    lane: Adapter,
    input?: { agentId?: string; attempt?: number; batchId?: string; reuseWorktreeOf?: string },
  ) => Promise<string>;
  // Inserts an already ended run of the member, for tests that only care about what follows it.
  ended: (state: string, reason: string | null, over?: EndedOverrides) => string;
}

interface EndedOverrides {
  agent_id?: string;
  model?: string | null;
  attempt?: number;
  batch_id?: string | null;
}

function seed(db: Database): { orgId: string; memberId: string; taskId: string } {
  const org = createOrg(db, {
    name: "A",
    slug: "aa",
    ownerUserId: "u1",
    ownerName: "O",
    ownerHandle: "owner",
  });
  const member = addAgentMember(db, org.id, {
    agentId: "claude",
    model: "opus",
    handle: "dev",
    displayName: "dev",
    specialties: [],
  });
  const profile = createProfile(db, org.id, {
    runtime: "claude",
    model: "opus",
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(db, member.id, profile.id);
  const project = createProject(db, { orgId: org.id, key: "web", name: "Web" });
  const task = createTask(db, { projectId: project.id, title: "Fix login", createdBy: member.id });
  return { orgId: org.id, memberId: member.id, taskId: task.id };
}

export function world(): World {
  const root = mkdtempSync(join(tmpdir(), "failover-test-"));
  dirs.push(root);
  const repo = join(root, "repo");
  initRepo(repo);
  const db = openDb(join(root, "harness.db"));
  migrate(db, migrations);
  const { orgId, memberId, taskId } = seed(db);
  const start: World["start"] = (lane, input = {}) => {
    const agentId = input.agentId ?? "claude";
    const deps = { home: join(root, "home"), port: 1, resolveSpec: () => specOf(agentId), lane };
    return startRun(db, deps, {
      agentId,
      repo,
      prompt: "go",
      model: "opus",
      taskId,
      member: { memberId, orgId, scopes: [] },
      ...input,
    });
  };
  const ended: World["ended"] = (state, reason, over = {}) => {
    const id = Bun.randomUUIDv7();
    db.run(
      `INSERT INTO runs (id, task_id, member_id, agent_id, model, repo, worktree, branch, prompt, state, reason, created_at, ended_at, attempt, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'b', 'p', ?, ?, 1, 2, ?, ?)`,
      [
        id,
        taskId,
        memberId,
        over.agent_id ?? "claude",
        over.model === undefined ? "opus" : over.model,
        repo,
        repo,
        state,
        reason,
        over.attempt ?? 1,
        over.batch_id ?? null,
      ],
    );
    return id;
  };
  return { db, repo, memberId, taskId, start, ended };
}
