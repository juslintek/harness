// Starts one server binary the way a user would: a fresh HARNESS_HOME, port 0, stdout parsed for the
// bound port. Nothing here imports server code, so the same suite judges the TS and the Zig build.
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyMigrations, openSeedDb } from "./seed";

const CODE_DIR = resolve(import.meta.dir, "../..");
const REPO_DIR = resolve(CODE_DIR, "..");
const STARTUP_MS = 30_000;
const STOP_MS = 10_000;
const LISTENING = /^harness listening on http:\/\/127\.0\.0\.1:(\d+)\/$/m;

export type Target = "ts" | "zig";

export interface AgentSpec {
  id: string;
  name: string;
  lane: "acp";
  bin: string;
  args: string[];
  versionArgs: string[];
  loginProbe: null;
  loginArgs: null;
  modeOption: null;
  egress: string[];
  stateWrite: string[];
  weakerNetworkIsolation: boolean;
  claudeMeta: boolean;
  mcp: boolean;
}

export interface BootOpts {
  // Runs against the migrated, still unopened database before the server starts.
  seed?: (db: Database) => void;
  target?: Target;
  agents?: AgentSpec[];
  env?: Record<string, string>;
}

export interface Booted {
  port: number;
  // The loopback address the sockets connect to; requests carry the Host of the RP origin instead.
  base: string;
  origin: string;
  home: string;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<void>;
}

function targetFromEnv(env: Record<string, string | undefined> = process.env): Target {
  const raw = env.HARNESS_TARGET ?? "ts";
  if (raw !== "ts" && raw !== "zig")
    throw new Error(`HARNESS_TARGET must be ts or zig, got ${raw}`);
  return raw;
}

export function commandFor(
  target: Target,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; cwd: string } {
  if (target === "ts") return { argv: [process.execPath, "src/main.ts"], cwd: CODE_DIR };
  const bin = resolve(env.HARNESS_ZIG_BIN ?? join(REPO_DIR, "zig/zig-out/bin/harness"));
  if (!existsSync(bin) || !statSync(bin).isFile()) {
    throw new Error(`zig binary not found: ${bin} (build it or set HARNESS_ZIG_BIN)`);
  }
  // The Zig binary is a multi-command tool and does nothing useful without a subcommand.
  return { argv: [bin, "serve"], cwd: dirname(bin) };
}

function pump(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // macOS answers EPERM, not ESRCH, for a group whose only members are zombies waiting to be reaped.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
  }
}

function parsePort(output: string): number | null {
  const match = LISTENING.exec(output);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function childEnv(home: string, opts: BootOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HARNESS_")) env[key] = value;
  }
  Object.assign(env, { HARNESS_HOME: home, HARNESS_PORT: "0", HARNESS_TEST: "1", ...opts.env });
  if (opts.agents) env.HARNESS_TEST_AGENTS = JSON.stringify(opts.agents);
  return env;
}

function seedHome(home: string, seed: (db: Database) => void): void {
  const db = openSeedDb(join(home, "harness.db"));
  try {
    applyMigrations(db);
    seed(db);
  } finally {
    db.close();
  }
}

async function waitForPort(
  proc: Bun.Subprocess,
  out: { text: string },
  fail: (why: string) => Promise<never>,
): Promise<number> {
  const deadline = Date.now() + STARTUP_MS;
  for (;;) {
    const port = parsePort(out.text);
    if (port !== null) return port;
    if (proc.exitCode !== null) return fail(`exited with ${proc.exitCode}`);
    if (Date.now() > deadline) return fail(`printed no listening line in ${STARTUP_MS} ms`);
    await Bun.sleep(25);
  }
}

export async function boot(opts: BootOpts = {}): Promise<Booted> {
  const target = opts.target ?? targetFromEnv();
  const { argv, cwd } = commandFor(target, { ...process.env, ...opts.env });
  if (process.env.CONFORMANCE_TRACE === "1") console.error(`conformance: boot ${target}`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-conf-")));
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    if (opts.seed) seedHome(home, opts.seed);
    proc = Bun.spawn(argv, {
      cwd,
      env: childEnv(home, opts),
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  const out = { text: "" };
  const err = { text: "" };
  pump(proc.stdout, out);
  pump(proc.stderr, err);
  const stop = async (): Promise<void> => {
    try {
      killGroup(proc.pid, "SIGTERM");
      const exited = await Promise.race([proc.exited, Bun.sleep(STOP_MS).then(() => null)]);
      // The server stops its agents on SIGTERM, each in a group of its own; this sweeps the rest of its group.
      killGroup(proc.pid, "SIGKILL");
      if (exited === null) await proc.exited;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  const port = await waitForPort(proc, out, async (why) => {
    await stop();
    throw new Error(`${target} server ${why}\nstdout:\n${out.text}\nstderr:\n${err.text}`);
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    origin: `http://localhost:${port}`,
    home,
    stdout: () => out.text,
    stderr: () => err.text,
    stop,
  };
}

// Boots on first use, so a run filtered with -t only starts the servers its scenarios need.
export function lazyBoot(opts: BootOpts): {
  get: () => Promise<Booted>;
  stop: () => Promise<void>;
} {
  let started: Promise<Booted> | undefined;
  return {
    get: () => {
      started ??= boot(opts);
      return started;
    },
    stop: async () => {
      if (started) await (await started.catch(() => undefined))?.stop();
    },
  };
}
