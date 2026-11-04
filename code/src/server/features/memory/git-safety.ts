import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { gitEnv } from "../../git-env";

// A repo in the vault dir is writable by anyone who can write a note file, and git runs commands
// named in its config (fsmonitor, filter drivers, ...). Every call therefore pins the repo
// location and neutralises the ambient config instead of trusting what git discovers.
export function vaultGitArgs(vault: string): string[] {
  return [
    `--git-dir=${join(vault, ".git")}`,
    `--work-tree=${vault}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    // Keeps a global or per-user attributes file from adding drivers the vault scan never saw.
    "-c",
    "core.attributesFile=/dev/null",
  ];
}

export function vaultGitEnv(): Record<string, string> {
  return { ...gitEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

const ALLOWED_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "user.name",
  "user.email",
]);

function refuse(why: string): never {
  throw new Error(
    `memory vault ${why}; remove it or replace it with a plain repository, then restart`,
  );
}

// `--file` reads that one file and never discovers a repo, so listing an untrusted config cannot
// itself run anything. -z keeps a multi-line value from being read as a second key.
function assertConfig(vault: string): void {
  const res = Bun.spawnSync(
    ["git", "config", "--file", join(vault, ".git", "config"), "--list", "-z"],
    { env: vaultGitEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0) refuse(".git/config cannot be read");
  for (const entry of res.stdout.toString().split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    if (!ALLOWED_KEYS.has(key)) refuse(`.git/config sets "${key}", which is not allowed`);
    if (key === "core.bare" && value !== "false") refuse(".git/config sets core.bare to true");
  }
}

const DRIVER = /(^|\s)(filter|diff|merge)=|textconv/m;

function hasDriver(file: string): boolean {
  const entry = lstatSync(file, { throwIfNoEntry: false });
  return entry?.isFile() === true && DRIVER.test(readFileSync(file, "utf8"));
}

function attributeFiles(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    if (e.isDirectory()) attributeFiles(join(dir, e.name), out);
    else if (e.name === ".gitattributes") out.push(join(dir, e.name));
  }
  return out;
}

// Git follows a symlinked ref, object or log path, so a commit could write outside the vault.
// These two files also redirect object or ref storage without being links.
const REDIRECTS = new Set([
  join(".git", "objects", "info", "alternates"),
  join(".git", "commondir"),
]);

const OBJECTS = join(".git", "objects") + sep;

// A hard link shares the inode with a file outside the vault, so a ref, log or index update
// would rewrite that file. Objects are immutable and local clones hard-link them legitimately.
function assertUnshared(vault: string, child: string): void {
  if (child.startsWith(OBJECTS)) return;
  if (lstatSync(join(vault, child)).nlink > 1) refuse(`${child} is hard-linked to another file`);
}

function assertPlainTree(vault: string, rel: string): void {
  for (const e of readdirSync(join(vault, rel), { withFileTypes: true })) {
    const child = join(rel, e.name);
    if (REDIRECTS.has(child)) refuse(`${child} redirects git storage`);
    if (e.isDirectory()) assertPlainTree(vault, child);
    else if (!e.isFile()) refuse(`${child} is not a regular file or directory`);
    else assertUnshared(vault, child);
  }
}

// Called before any git command touches an existing vault repo.
export function assertSafeVaultRepo(vault: string): void {
  if (lstatSync(join(vault, ".git"), { throwIfNoEntry: false }) === undefined) return;
  assertPlainTree(vault, ".git");
  assertConfig(vault);
  const files = [join(vault, ".git", "info", "attributes"), ...attributeFiles(vault, [])];
  const bad = files.find(hasDriver);
  if (bad !== undefined) refuse(`${bad} defines a filter, diff, merge or textconv driver`);
}
