import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../git-env";
import { vaultDir } from "./vault";

const COMMIT_DEBOUNCE_MS = 500;
const GIT_TIMEOUT_MS = 30_000;
const IDENT = [
  "-c",
  "user.name=harness",
  "-c",
  "user.email=harness@localhost",
  "-c",
  "commit.gpgsign=false",
];

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...IDENT, ...args], {
    cwd,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  return { code, out: stdout + stderr };
}

async function initRepo(home: string): Promise<void> {
  const dir = vaultDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(join(dir, ".git"))) return;
  writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
  const res = await git(dir, ["init", "-q"]);
  if (res.code !== 0) throw new Error(`git init failed: ${res.out}`);
}

// Memoized so the startup init and the first debounced commit cannot run `git init` twice.
const ready = new Map<string, Promise<void>>();

export function ensureVaultRepo(home: string): Promise<void> {
  let p = ready.get(home);
  if (p === undefined) {
    p = initRepo(home);
    ready.set(home, p);
    p.catch(() => ready.delete(home));
  }
  return p;
}

async function commitAll(home: string, message: string): Promise<void> {
  try {
    await ensureVaultRepo(home);
    const dir = vaultDir(home);
    const add = await git(dir, ["add", "-A"]);
    if (add.code !== 0) throw new Error(add.out);
    const commit = await git(dir, ["commit", "-q", "-m", message]);
    if (commit.code !== 0 && !commit.out.includes("nothing to commit")) throw new Error(commit.out);
  } catch (e) {
    // History is a convenience; a failed commit must not break the write that queued it.
    console.error(`memory: git commit failed: ${(e as Error).message}`);
  }
}

const pending = new Map<string, string[]>();
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

function flush(): void {
  timer = null;
  for (const [home, messages] of pending) {
    const message =
      messages.length === 1 ? (messages[0] as string) : `${messages.length} note changes`;
    chain = chain.then(() => commitAll(home, message));
  }
  pending.clear();
}

// The window starts at the first queued write, so a steady stream of writes still commits.
export function queueCommit(home: string, message: string): void {
  pending.set(home, [...(pending.get(home) ?? []), message]);
  timer ??= setTimeout(flush, COMMIT_DEBOUNCE_MS);
}

export async function drainCommits(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    flush();
  }
  await chain;
}
