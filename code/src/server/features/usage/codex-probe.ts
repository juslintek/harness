import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAccountExhaustion,
  getAccount,
  listAccounts,
  markAccountExhausted,
  recordAccountQuotaProbe,
} from "../agents/api";
import { type CodexProbeResult, type PipeProc, runCodexProbeProtocol } from "./codex-probe-rpc";
import { insertSnapshot, latestQuota } from "./quota";

export interface CodexProbeHandle {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  finish: (() => Promise<void>) | null;
}

export type CodexProbeLauncher = (
  dir: string,
  account: { id: string; home: string | null },
) => Promise<CodexProbeHandle>;

export interface CodexProbeOpts {
  home: string;
  launch: CodexProbeLauncher;
  timeoutMs?: number;
  now?: () => number;
}

export type { CodexProbeResult };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_AGE_MS = 5 * 60_000;
const FALLBACK_EXHAUSTION_MS = 15 * 60_000;
const CANDIDATE_STATES = new Set(["active", "unknown"]);

function killPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function stopProcess(proc: PipeProc): Promise<void> {
  try {
    proc.stdin.end();
  } catch {
    // Stdin already closed.
  }
  await Promise.race([proc.exited, Bun.sleep(20)]);
  if (proc.exitCode !== null) return;
  killPid(proc.pid, "SIGTERM");
  const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(200)]);
  if (done !== true && proc.exitCode === null) {
    killPid(proc.pid, "SIGKILL");
    await Promise.race([proc.exited, Bun.sleep(500)]);
  }
}

async function probeSession(
  account: { id: string; home: string | null },
  opts: CodexProbeOpts,
): Promise<CodexProbeResult> {
  const dir = join(opts.home, "quota-probes", Bun.randomUUIDv7());
  let handle: CodexProbeHandle | null = null;
  let proc: PipeProc | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(dir, { recursive: true });
    handle = await opts.launch(dir, { id: account.id, home: account.home });
    proc = Bun.spawn(handle.argv, {
      cwd: handle.cwd,
      env: handle.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    void new Response(proc.stderr).text().catch(() => "");
    const timeout = new Promise<CodexProbeResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "probe_failed", error: "timeout" }),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });
    return await Promise.race([
      runCodexProbeProtocol(proc, account.id, opts.now ?? Date.now).catch(
        (err): CodexProbeResult => ({
          status: "probe_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
      timeout,
    ]);
  } catch (err) {
    return { status: "probe_failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    if (proc) await stopProcess(proc);
    await handle?.finish?.().catch((err) => console.error("codex probe finish failed", err));
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      console.error("codex probe cleanup failed", err),
    );
  }
}

function applyProbeResult(
  db: Database,
  account: { id: string; exhaustedUntil: number | null },
  result: CodexProbeResult,
  now: number,
): void {
  if (result.status === "logged_out") {
    recordAccountQuotaProbe(db, account.id, { state: "logged_out", lastProbeAt: now });
    return;
  }
  if (result.status !== "ok") return;
  for (const snap of result.snapshots) insertSnapshot(db, snap);
  recordAccountQuotaProbe(db, account.id, { state: "active", lastProbeAt: now });
  const full = result.snapshots.filter((s) => s.usedPercent !== null && s.usedPercent >= 100);
  if (full.length > 0) {
    const future = full.map((s) => s.resetsAt).filter((r): r is number => r !== null && r > now);
    markAccountExhausted(
      db,
      account.id,
      future.length > 0 ? Math.max(...future) : now + FALLBACK_EXHAUSTION_MS,
    );
  } else if (account.exhaustedUntil !== null) {
    clearAccountExhaustion(db, account.id);
  }
}

export async function probeCodexAccount(
  db: Database,
  accountId: string,
  opts: CodexProbeOpts,
): Promise<CodexProbeResult> {
  const account = getAccount(db, accountId);
  if (account?.runtime !== "codex" || account.kind !== "login") {
    return { status: "probe_failed", error: "not a codex login account" };
  }
  const result = await probeSession(account, opts);
  const current = getAccount(db, accountId);
  if (!current || ["disabled", "removing", "removed"].includes(current.state)) {
    return result;
  }
  const now =
    result.status === "ok"
      ? (result.snapshots[0]?.ts ?? (opts.now ?? Date.now)())
      : (opts.now ?? Date.now)();
  applyProbeResult(db, current, result, now);
  return result;
}

export async function probeCandidateCodexAccounts(
  db: Database,
  opts: CodexProbeOpts & { minAgeMs?: number; shouldStop?: () => boolean },
): Promise<Map<string, CodexProbeResult>> {
  const now = (opts.now ?? Date.now)();
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const results = new Map<string, CodexProbeResult>();
  const candidates = listAccounts(db, "codex").filter(
    (a) => a.kind === "login" && CANDIDATE_STATES.has(a.state),
  );
  for (const account of candidates) {
    if (opts.shouldStop?.()) break;
    const fresh = latestQuota(db, account.id, now).some(
      (v) => v.provider === "codex" && v.usedPercent !== null && now - v.ts < minAgeMs,
    );
    if (!fresh) results.set(account.id, await probeCodexAccount(db, account.id, opts));
  }
  return results;
}

export function startCodexQuotaProbe(
  db: Database,
  opts: CodexProbeOpts & { intervalMs?: number; minAgeMs?: number },
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const tick = (): void => {
    if (stopped || inFlight) return;
    const sweep = probeCandidateCodexAccounts(db, { ...opts, shouldStop: () => stopped })
      .catch((err: unknown) => console.error("codex quota probe sweep failed", err))
      .finally(() => {
        if (inFlight === sweep) inFlight = null;
      });
    inFlight = sweep;
  };
  const timer = setInterval(tick, opts.intervalMs ?? DEFAULT_MIN_AGE_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
