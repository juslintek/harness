import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../agents/api";
import { getSpec } from "../agents/api";
import type { NewEvent } from "../logs/api";
import { runAcp } from "./acp";
import type { PermissionAsk, RunContext, RunOutcome } from "./adapter";

const FAKE = join(import.meta.dir, "../../../../scripts/fake-acp-agent.ts");
export const dir: string = mkdtempSync(join(tmpdir(), "acp-test-"));
let seq = 0;

// Several test files share this module in one process, so the directory goes at exit.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

export interface Harness {
  outcome: RunOutcome;
  events: NewEvent[];
  asks: PermissionAsk[];
  quotas: Array<Parameters<RunContext["onQuota"]>[0]>;
  pid: number;
  faults: unknown[];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

export interface Opts {
  verdict?: "allow" | "deny" | "throw" | "hang";
  decideTimeoutMs?: number;
  failConfig?: boolean;
  throwOn?: (e: NewEvent) => boolean;
  idleTimeoutMs?: number;
  spec?: AgentSpec | null;
  model?: string | null;
  mcp?: RunContext["mcp"];
  abortWhen?: (e: NewEvent) => boolean;
  onSpawn?: (pid: number) => void;
}

function decider(opts: Opts, asks: PermissionAsk[]): RunContext["decide"] {
  return (ask) => {
    asks.push(ask);
    if (opts.verdict === "throw") return Promise.reject(new Error("guard down"));
    if (opts.verdict === "hang") return new Promise(() => {});
    return Promise.resolve(opts.verdict ?? "deny");
  };
}

export async function drive(script: unknown[], opts: Opts = {}): Promise<Harness> {
  const id = ++seq;
  const pidFile = join(dir, `pid-${id}`);
  const logFile = join(dir, `log-${id}`);
  const events: NewEvent[] = [];
  const asks: PermissionAsk[] = [];
  const faults: unknown[] = [];
  const quotas: Harness["quotas"] = [];
  const abort = new AbortController();
  let spawned = 0;
  const spec = opts.spec === undefined ? getSpec("claude") : opts.spec;
  if (!spec) throw new Error("spec missing");
  const outcome = await runAcp({
    runId: `run-${id}`,
    cwd: dir,
    prompt: "go",
    model: opts.model ?? null,
    spec,
    argv: [process.execPath, FAKE],
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_AGENT_SCRIPT: JSON.stringify(script),
      FAKE_AGENT_PIDFILE: pidFile,
      FAKE_AGENT_LOG: logFile,
      ...(opts.failConfig ? { FAKE_AGENT_FAIL_CONFIG: "1" } : {}),
    },
    mcp: opts.mcp ?? null,
    claudeSettings: { hooks: {} },
    emit: (e) => {
      events.push(e);
      if (opts.throwOn?.(e)) throw new Error("db busy");
      if (opts.abortWhen?.(e)) abort.abort();
    },
    decide: decider(opts, asks),
    ...(opts.decideTimeoutMs === undefined ? {} : { decideTimeoutMs: opts.decideTimeoutMs }),
    onSpawn: (pid) => {
      spawned = pid;
      opts.onSpawn?.(pid);
    },
    onQuota: (q) => quotas.push(q),
    signal: abort.signal,
    logError: (_message, err) => faults.push(err),
    idleTimeoutMs: opts.idleTimeoutMs ?? 10_000,
  });
  const requests = (existsSync(logFile) ? readFileSync(logFile, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { outcome, events, asks, quotas, requests, faults, pid: spawned };
}

export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export const messages = (h: Harness): string[] =>
  h.events.filter((e) => e.kind === "message").map((e) => e.body ?? "");
