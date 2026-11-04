import type { Database } from "bun:sqlite";
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
  // The vault is the harness's own repo; the user's global hooks must not run on its commits.
  "-c",
  "core.hooksPath=/dev/null",
];

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", ...IDENT, ...args], {
    cwd,
    // "nothing to commit" is matched below, so the message must not be translated.
    env: { ...gitEnv(), LC_ALL: "C" },
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

// Changed or untracked notes, as paths inside the vault. Rename entries carry a second path.
async function changedNotes(dir: string): Promise<string[]> {
  const res = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (res.code !== 0) return [];
  const out: string[] = [];
  const parts = res.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    if (entry[0] === "R" || entry[0] === "C") i++;
    const path = entry.slice(3);
    const inside = !path.startsWith(".git") && !path.split("/").includes("..");
    if (inside && path.endsWith(".md")) out.push(path);
  }
  return out;
}

// A file edited by hand since the last commit may hold a secret the watcher has not scrubbed yet;
// syncing it first means only redacted text is ever staged. The syncing function is registered by
// the outside module, which imports this one and so cannot be imported back.
type Syncer = (db: Database, home: string, disk: string) => unknown;
let syncer: Syncer | null = null;

export function setOutsideSyncer(fn: Syncer): void {
  syncer = fn;
}

async function scrubOutside(db: Database, home: string, dir: string): Promise<void> {
  if (syncer === null) return;
  for (const disk of await changedNotes(dir)) {
    try {
      syncer(db, home, disk);
    } catch (e) {
      console.error(`memory: scrub before commit failed for ${disk}: ${(e as Error).message}`);
    }
  }
}

async function commitAll(home: string, message: string, db: Database | undefined): Promise<void> {
  try {
    await ensureVaultRepo(home);
    const dir = vaultDir(home);
    if (db !== undefined) await scrubOutside(db, home, dir);
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
const databases = new Map<string, Database>();
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

function flush(): void {
  timer = null;
  for (const [home, messages] of pending) {
    const message =
      messages.length === 1 ? (messages[0] as string) : `${messages.length} note changes`;
    const db = databases.get(home);
    chain = chain.then(() => commitAll(home, message, db));
  }
  pending.clear();
}

// The window starts at the first queued write, so a steady stream of writes still commits.
export function queueCommit(home: string, message: string, db?: Database): void {
  if (db !== undefined) databases.set(home, db);
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
