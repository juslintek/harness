import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { gitEnv } from "../../git-env";
import type { AgentSpec } from "../agents/api";
import { listRunEvents, readBody } from "../logs/api";
import type { RunDeps } from "./api";

const FAKE = join(import.meta.dir, "../../../../scripts/fake-acp-agent.ts");
const dirs: string[] = [];

export interface Fixture {
  db: Database;
  home: string;
  repo: string;
}

function git(args: string[], cwd: string): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "manager-test-"));
  dirs.push(dir);
  return dir;
}

export function fixture(): Fixture {
  const root = makeDir();
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "a");
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], repo);
  const home = join(root, "home");
  const db = openDb(join(root, "harness.db"));
  migrate(db, migrations);
  return { db, home, repo };
}

export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const fakeSpec: AgentSpec = {
  id: "fake",
  name: "Fake",
  lane: "acp",
  bin: process.execPath,
  args: [FAKE],
  versionArgs: [],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
};

// Inside srt only the run's tmp dir is writable, so the pid file lives there.
export function fakeDeps(f: Fixture, script: unknown[], extra: Partial<RunDeps> = {}): RunDeps {
  return {
    home: f.home,
    port: 1,
    resolveSpec: (id) => (id === "fake" ? fakeSpec : null),
    idleTimeoutMs: 15_000,
    agentEnv: (runDir) => ({
      FAKE_AGENT_SCRIPT: JSON.stringify(script),
      FAKE_AGENT_PIDFILE: join(runDir, "tmp", "pid"),
    }),
    ...extra,
  };
}

export function agentPid(f: Fixture, runId: string): number {
  return Number(readFileSync(join(f.home, "runs", runId, "tmp", "pid"), "utf8"));
}

export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// The adapter coalesces consecutive text chunks, so steps run back to back read as one string.
export function transcript(f: Fixture, runId: string): string {
  return listRunEvents(f.db, runId)
    .filter((e) => e.kind === "message")
    .map((e) => readBody(f.db, e.rowid) ?? "")
    .join("");
}

export function firstSshEntry(): string {
  const ssh = join(homedir(), ".ssh");
  const files = readdirSync(ssh).filter((name) => statSync(join(ssh, name)).isFile());
  return join(ssh, files[0] ?? "id_ed25519");
}
