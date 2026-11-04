import type { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { redact } from "../logs/api";
import { assertSafeVaultRepo, vaultGitArgs, vaultGitEnv } from "./git-safety";
import { diskToLocated } from "./paths";
import { vaultDir } from "./vault";

const COMMIT_DEBOUNCE_MS = 500;
const GIT_TIMEOUT_MS = 30_000;
const STAGE_CHUNK = 200;
const IDENT = [
  "-c",
  "user.name=harness",
  "-c",
  "user.email=harness@localhost",
  "-c",
  "commit.gpgsign=false",
];

// The vault is writable by anyone who can write a note, so its git metadata is checked again
// before each command, not only at start: a config key or attributes file added later would
// otherwise make the next `git add` run an attacker's filter.
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  assertVaultDir(cwd);
  const proc = Bun.spawn(["git", ...vaultGitArgs(cwd), ...IDENT, ...args], {
    cwd,
    // "nothing to commit" is matched below, so the message must not be translated.
    env: { ...vaultGitEnv(), LC_ALL: "C" },
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

// Everything but folders and notes is ignored, so a stray credentials file in the vault is never
// picked up by a broad `git add`. Existing entries stay; the missing ones are appended in order
// because a later "!" rule must follow the "*" it carves out of.
const IGNORE_RULES = ["*.tmp", "*", "!*/", "!*.md"];

// lstat, not stat: a symlinked .gitignore would make the write below land on its target outside
// the vault. Anything that is not a plain file is replaced by a fresh file through a rename, which
// swaps the entry itself and never follows the link.
function writeIgnore(dir: string): void {
  const file = join(dir, ".gitignore");
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (entry !== undefined && !entry.isFile()) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${IGNORE_RULES.join("\n")}\n`);
    if (entry.isDirectory()) rmSync(file, { recursive: true });
    renameSync(tmp, file);
    return;
  }
  const current = entry === undefined ? "" : readFileSync(file, "utf8");
  const have = new Set(current.split("\n"));
  const missing = IGNORE_RULES.filter((r) => !have.has(r));
  if (missing.length === 0) return;
  const head = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  writeFileSync(file, `${head}${missing.join("\n")}\n`);
}

// A .git symlink or "gitdir:" file would point git, and every commit and revert, at a repository
// outside the vault. Nothing is deleted: the operator has to look at it.
export function assertVaultGit(home: string): void {
  assertVaultDir(vaultDir(home));
}

function assertVaultDir(dir: string): void {
  const entry = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isDirectory()) {
    assertSafeVaultRepo(dir);
    return;
  }
  throw new Error(
    `memory vault .git is a ${entry.isSymbolicLink() ? "symlink" : "file"}, not a directory; ` +
      "remove it or replace it with a real repository, then restart",
  );
}

async function initRepo(home: string): Promise<void> {
  const dir = vaultDir(home);
  assertVaultGit(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeIgnore(dir);
  if (existsSync(join(dir, ".git"))) return;
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
    if (inside && path.endsWith(".md") && diskToLocated(path) !== null) out.push(path);
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

function scrubOutside(db: Database, home: string, notes: string[]): void {
  if (syncer === null) return;
  for (const disk of notes) syncer(db, home, disk);
}

// Only paths a note can have are staged (never -A), and pathspec magic is switched off so a file
// named like ":(glob)*" cannot widen the match.
async function stageNotes(dir: string, notes: string[]): Promise<void> {
  for (let i = 0; i < notes.length; i += STAGE_CHUNK) {
    const add = await git(dir, [
      "--literal-pathspecs",
      "add",
      "--",
      ...notes.slice(i, i + STAGE_CHUNK),
    ]);
    if (add.code !== 0) throw new Error(add.out);
  }
}

// Last line of defence: whatever got staged is checked as the blob git will store, and a note that
// redaction would still change is unstaged, so a failed rewrite can never reach history.
async function unstageSecrets(dir: string): Promise<void> {
  const staged = await git(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=d"]);
  for (const path of staged.out.split("\0")) {
    if (!path.endsWith(".md")) continue;
    const blob = await git(dir, ["show", `:${path}`]);
    if (blob.code !== 0 || redact(blob.out) === blob.out) continue;
    await git(dir, ["reset", "-q", "--", path]);
    console.error(`memory: not committing ${path}: it still holds a secret`);
  }
}

// Anything staged by hand before we got here (git add -f ignores the ignore rules) would ride along
// in the commit, so a non-note path is unstaged whatever put it in the index.
async function unstageNonNotes(dir: string): Promise<void> {
  const staged = await git(dir, ["diff", "--cached", "--name-only", "-z"]);
  for (const path of staged.out.split("\0")) {
    if (path === "" || (path.endsWith(".md") && diskToLocated(path) !== null)) continue;
    await git(dir, ["--literal-pathspecs", "reset", "-q", "--", path]);
    console.error(`memory: not committing ${path}: it is not a note`);
  }
}

async function commitAll(home: string, message: string, db: Database | undefined): Promise<void> {
  try {
    await ensureVaultRepo(home);
    const dir = vaultDir(home);
    if (db !== undefined) scrubOutside(db, home, await changedNotes(dir));
    // Back to HEAD first: tracked notes keep their history, and only what stageNotes adds is staged.
    await git(dir, ["reset", "-q"]);
    await stageNotes(dir, await changedNotes(dir));
    await unstageNonNotes(dir);
    await unstageSecrets(dir);
    const commit = await git(dir, ["commit", "-q", "-m", message]);
    if (commit.code !== 0 && !/nothing (added )?to commit/.test(commit.out))
      throw new Error(commit.out);
  } catch (e) {
    // History is a convenience; a failed commit must not break the write that queued it. A scrub
    // that threw lands here too, so unchecked content is never committed.
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
