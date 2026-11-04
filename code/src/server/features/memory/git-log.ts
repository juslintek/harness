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
// A lock or a full disk is usually gone within seconds, so a failed commit is tried again a few
// times instead of leaving the notes uncommitted until the next write.
const RETRY_MS = [1_000, 5_000, 30_000];
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

// Staging and cleanup commands go through here: a reset that failed leaves whatever was staged
// by hand in the index, so the attempt is abandoned (and retried) instead of reaching `git commit`.
async function must(dir: string, args: string[]): Promise<string> {
  const res = await git(dir, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.out}`);
  return res.out;
}

// Everything but folders and notes is ignored, so a stray credentials file in the vault is never
// picked up by a broad `git add`. The rules are always the last lines: gitignore is last match wins,
// so a user's "*.md" after them would otherwise hide every note, and a later "!" rule must follow
// the "*" it carves out of. The user's other lines stay above them.
const IGNORE_RULES = ["*.tmp", "*", "!*/", "!*.md"];

// The file is never written in place: a symlink or a hard link would carry the write to a file
// outside the vault, so the new content goes to a tmp file that a rename then swaps in for the entry
// itself. Only a plain file's own rules are kept; for anything else the tmp is a fresh list.
function writeIgnore(dir: string): void {
  const file = join(dir, ".gitignore");
  const entry = lstatSync(file, { throwIfNoEntry: false });
  const current = entry?.isFile() ? readFileSync(file, "utf8") : "";
  const kept = current.split("\n").filter((l) => !IGNORE_RULES.includes(l));
  while (kept.at(-1) === "") kept.pop();
  const next = `${[...kept, ...IGNORE_RULES].join("\n")}\n`;
  if (entry?.isFile() && next === current) return;
  const tmp = `${file}.${process.pid}.tmp`;
  // "wx" after the rm: a pre-placed symlink at the tmp name is never followed either.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, next, { flag: "wx" });
  if (entry?.isDirectory()) rmSync(file, { recursive: true });
  renameSync(tmp, file);
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

// Changed or untracked notes, as paths inside the vault. Rename entries carry a second path. A
// failed status throws: an empty list would read as "nothing changed" and skip the commit.
async function changedNotes(dir: string): Promise<string[]> {
  const status = await must(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const out: string[] = [];
  const parts = status.split("\0");
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
    await must(dir, ["--literal-pathspecs", "add", "--", ...notes.slice(i, i + STAGE_CHUNK)]);
  }
}

// Last line of defence: whatever got staged is checked as the blob git will store, and a note that
// redaction would still change is unstaged, so a failed rewrite can never reach history.
async function unstageSecrets(dir: string): Promise<void> {
  const staged = await must(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=d"]);
  for (const path of staged.split("\0")) {
    if (!path.endsWith(".md")) continue;
    const blob = await must(dir, ["show", `:${path}`]);
    if (redact(blob) === blob) continue;
    await must(dir, ["--literal-pathspecs", "reset", "-q", "--", path]);
    console.error(`memory: not committing ${path}: it still holds a secret`);
  }
}

// Anything staged by hand before we got here (git add -f ignores the ignore rules) would ride along
// in the commit, so a non-note path is unstaged whatever put it in the index.
async function unstageNonNotes(dir: string): Promise<void> {
  const staged = await must(dir, ["diff", "--cached", "--name-only", "-z"]);
  for (const path of staged.split("\0")) {
    if (path === "" || (path.endsWith(".md") && diskToLocated(path) !== null)) continue;
    await must(dir, ["--literal-pathspecs", "reset", "-q", "--", path]);
    console.error(`memory: not committing ${path}: it is not a note`);
  }
}

// `git add` stages a symlink as mode 120000 and a nested repo as a gitlink (160000), and neither
// is note text, so only regular blobs may reach the commit. Deletions (mode 000000) stay.
async function unstageNonFiles(dir: string): Promise<void> {
  const parts = (await must(dir, ["diff", "--cached", "--raw", "--no-renames", "-z"])).split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const newMode = (parts[i] as string).split(" ")[1];
    const path = parts[i + 1] as string;
    if (newMode === "100644" || newMode === "100755" || newMode === "000000") continue;
    await must(dir, ["--literal-pathspecs", "reset", "-q", "--", path]);
    console.error(`memory: not committing ${path}: it is not a regular file`);
  }
}

async function commitAll(
  home: string,
  message: string,
  db: Database | undefined,
): Promise<boolean> {
  try {
    await ensureVaultRepo(home);
    const dir = vaultDir(home);
    // A rule appended after start (a hand-edited "*.md") would hide every note until restart.
    writeIgnore(dir);
    if (db !== undefined) scrubOutside(db, home, await changedNotes(dir));
    // Back to HEAD first: tracked notes keep their history, and only what stageNotes adds is staged.
    await must(dir, ["reset", "-q"]);
    await stageNotes(dir, await changedNotes(dir));
    await unstageNonNotes(dir);
    await unstageNonFiles(dir);
    await unstageSecrets(dir);
    const commit = await git(dir, ["commit", "-q", "-m", message]);
    if (commit.code !== 0 && !/nothing (added )?to commit/.test(commit.out))
      throw new Error(commit.out);
    return true;
  } catch (e) {
    // History is a convenience; a failed commit must not break the write that queued it. A scrub
    // that threw lands here too, so unchecked content is never committed.
    console.error(`memory: git commit failed: ${(e as Error).message}`);
    return false;
  }
}

const pending = new Map<string, string[]>();
const databases = new Map<string, Database>();
const attempts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

// The messages go back in front of anything queued meanwhile. The retry timer is unref'd so it
// never keeps the process alive; startup recovery covers notes still uncommitted after the last try.
function retryLater(home: string, messages: string[]): void {
  const done = attempts.get(home) ?? 0;
  const delay = RETRY_MS[done];
  if (delay === undefined) {
    attempts.delete(home);
    console.error("memory: giving up on the git commit; the notes stay on disk");
    return;
  }
  attempts.set(home, done + 1);
  pending.set(home, [...messages, ...(pending.get(home) ?? [])]);
  timer ??= setTimeout(flush, delay);
  timer.unref();
}

async function commitOrRetry(home: string, messages: string[]): Promise<void> {
  const message =
    messages.length === 1 ? (messages[0] as string) : `${messages.length} note changes`;
  if (await commitAll(home, message, databases.get(home))) attempts.delete(home);
  else retryLater(home, messages);
}

function flush(): void {
  timer = null;
  for (const [home, messages] of pending) chain = chain.then(() => commitOrRetry(home, messages));
  pending.clear();
}

// The window starts at the first queued write, so a steady stream of writes still commits.
export function queueCommit(home: string, message: string, db?: Database): void {
  if (db !== undefined) databases.set(home, db);
  pending.set(home, [...(pending.get(home) ?? []), message]);
  timer ??= setTimeout(flush, COMMIT_DEBOUNCE_MS);
}

// Covers a crash, or retries that ran out, since neither leaves a queued commit behind.
export async function queueUncommitted(home: string, db: Database): Promise<void> {
  await ensureVaultRepo(home);
  const changed = await changedNotes(vaultDir(home)).then(
    (notes) => notes.length > 0,
    // Unknown state: queue anyway, so the commit path's own retries look again.
    () => true,
  );
  if (changed) queueCommit(home, "commit notes left uncommitted", db);
}

// Stopping gives a waiting commit or retry one last immediate attempt; whatever still fails is
// dropped with its timer, because the next start recommits it.
export async function drainCommits(): Promise<void> {
  if (timer !== null) clearTimeout(timer);
  flush();
  await chain;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending.clear();
  attempts.clear();
}
