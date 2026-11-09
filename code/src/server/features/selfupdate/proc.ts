import { z } from "zod";
import { gitEnv } from "../../git-env";

const POLL_MS = 200;
const KILL_GRACE_MS = 5000;

export interface CommandResult {
  code: number;
  out: string;
}

export interface Launched {
  exited: Promise<number>;
  stop: () => Promise<void>;
}

// The pipeline's children must never see the live server's identity: a `bun run check` that
// inherited HARNESS_HOME would test against live data.
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = gitEnv();
  for (const key of Object.keys(env)) if (key.startsWith("HARNESS_")) delete env[key];
  return { ...env, ...extra };
}

export async function runCommand(
  argv: string[],
  cwd: string,
  env: Record<string, string> = childEnv(),
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  return { code: await proc.exited, out: `${out}${err}`.trim() };
}

const healthBody = z.object({ ok: z.literal(true), version: z.string() });

async function probeVersion(port: number): Promise<string | null> {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
    .then((res) => res.json())
    .then((body) => {
      const parsed = healthBody.safeParse(body);
      return parsed.success ? parsed.data.version : null;
    })
    .catch(() => null);
}

// `version` undefined accepts any healthy answer. A process that exits first fails at once
// instead of burning the whole timeout.
export async function waitHealth(
  port: number,
  version: string | undefined,
  timeoutMs: number,
  exited: Promise<number>,
): Promise<void> {
  let dead = false;
  void exited.then(() => {
    dead = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead) throw new Error("server exited before it answered /api/health");
    const seen = await probeVersion(port);
    if (seen !== null && (version === undefined || seen === version)) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`no healthy ${version ?? "server"} on port ${port} within ${timeoutMs} ms`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline)
      throw new Error(`process ${pid} still running after ${timeoutMs} ms`);
    await Bun.sleep(POLL_MS);
  }
}

export interface ServerSpot {
  home: string;
  port: number;
  log: string;
}

// Detached with its output in a file so it outlives the swap process that started it.
export function spawnServer(binary: string, spot: ServerSpot): Launched {
  const proc = Bun.spawn([binary], {
    env: { ...process.env, HARNESS_HOME: spot.home, HARNESS_PORT: `${spot.port}` },
    stdin: "ignore",
    stdout: Bun.file(spot.log),
    stderr: Bun.file(spot.log),
    detached: true,
  });
  proc.unref();
  return { exited: proc.exited, stop: () => stopProcess(proc) };
}

export async function stopProcess(proc: {
  kill: (signal?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
}): Promise<void> {
  proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  await proc.exited;
  clearTimeout(timer);
}
