import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version as ownVersion } from "../../version";
import { type Launched, type ServerSpot, spawnServer, waitHealth, waitPidExit } from "./proc";
import { appendLog, setStatus, type UpdateStatus } from "./requests";
import { restoreSnapshot } from "./snapshot";

export interface SwapOptions {
  oldPid: number;
  current: string;
  previous: string;
  home: string;
  port: number;
  snapshot: string;
  request: string;
  // The swap runs inside the new binary, so its own version is what the live port must report.
  version: string;
}

// The injection point for service-managed installs: there `launch` runs the restart command
// (the unit executes the `current` symlink) instead of spawning the binary itself.
export interface SwapDeps {
  launch: (binary: string, spot: ServerSpot) => Launched;
  healthMs: number;
  oldExitMs: number;
}

const DEFAULT_DEPS: SwapDeps = { launch: spawnServer, healthMs: 30_000, oldExitMs: 60_000 };

// Lets a booting server tell a swap that is still running from one that was killed.
export function swapPidFile(home: string, request: string): string {
  return join(home, "snapshots", `${request}-swap.pid`);
}

export function flipSymlink(link: string, target: string): void {
  mkdirSync(join(link, ".."), { recursive: true });
  const tmp = `${link}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

// A plain connection: the server that owns the db is either gone or being replaced.
function record(home: string, request: string, status: UpdateStatus, note: string): void {
  const db = new Database(join(home, "harness.db"));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    setStatus(db, request, status, status === "done" ? undefined : note);
    appendLog(db, request, `swap: ${status}: ${note}`);
  } finally {
    db.close();
  }
}

async function rollback(opts: SwapOptions, deps: SwapDeps, reason: string): Promise<"rolled_back"> {
  const spot = {
    home: opts.home,
    port: opts.port,
    log: join(opts.home, `selfupdate-${opts.request}.log`),
  };
  restoreSnapshot(opts.home, opts.snapshot);
  flipSymlink(opts.current, opts.previous);
  const old = deps.launch(opts.previous, spot);
  try {
    await waitHealth(opts.port, undefined, deps.healthMs, old.exited);
  } catch (err) {
    await old.stop();
    record(
      opts.home,
      opts.request,
      "failed",
      `${reason}; previous binary did not start: ${(err as Error).message}`,
    );
    throw err;
  }
  record(opts.home, opts.request, "rolled_back", reason);
  return "rolled_back";
}

export async function swap(
  opts: SwapOptions,
  deps: SwapDeps = DEFAULT_DEPS,
): Promise<"done" | "rolled_back"> {
  const pidFile = swapPidFile(opts.home, opts.request);
  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, `${process.pid}`);
  try {
    return await runSwap(opts, deps);
  } finally {
    rmSync(pidFile, { force: true });
  }
}

async function runSwap(opts: SwapOptions, deps: SwapDeps): Promise<"done" | "rolled_back"> {
  const newBinary = realpathSync(opts.current);
  const spot = {
    home: opts.home,
    port: opts.port,
    log: join(opts.home, `selfupdate-${opts.request}.log`),
  };
  let started: Launched | undefined;
  try {
    await waitPidExit(opts.oldPid, deps.oldExitMs);
    started = deps.launch(newBinary, spot);
    await waitHealth(opts.port, opts.version, deps.healthMs, started.exited);
  } catch (err) {
    await started?.stop();
    return rollback(opts, deps, (err as Error).message);
  }
  record(opts.home, opts.request, "done", `now running ${opts.version}`);
  return "done";
}

const FLAGS = ["old-pid", "current", "previous", "home", "port", "snapshot", "request"] as const;

export function parseSwapArgs(args: string[]): SwapOptions {
  const value = (name: string): string => {
    const at = args.indexOf(`--${name}`);
    const found = at === -1 ? undefined : args[at + 1];
    if (!found) throw new Error(`swap: missing --${name} (needs ${FLAGS.join(", ")})`);
    return found;
  };
  return {
    oldPid: Number(value("old-pid")),
    current: value("current"),
    previous: value("previous"),
    home: value("home"),
    port: Number(value("port")),
    snapshot: value("snapshot"),
    request: value("request"),
    version: ownVersion,
  };
}
