import { realpathSync } from "node:fs";
import { resolvePath, type Scope } from "./rules-core";
import type { Cmd } from "./shell";

// Anything else in front of a command (GIT_PAGER, GIT_DIR, LD_PRELOAD, PATH, ...) can change what runs.
const HARMLESS_ENV = /^(LC_[A-Z_]+|LANG|TZ|NO_COLOR|TERM|COLUMNS)=/;

// `env -i cmd` and `env X=1 cmd` are stripped to `cmd` by the parser, so the wrapper name is the
// only trace left of them.
export function plainEnv(cmd: Cmd): boolean {
  return cmd.assigns.every((a) => HARMLESS_ENV.test(a)) && !cmd.wrappers.includes("env");
}

// Long options that write a file, run a configured program, open a pager or read outside the repo.
// git accepts any unambiguous prefix, so a flag counts when either side is a prefix of the other.
const UNSAFE_LONG = [
  "output",
  "ext-diff",
  "textconv",
  "filters",
  "open-files-in-pager",
  "no-index",
  "contents",
  "exec-path",
  "git-dir",
  "work-tree",
  "config-env",
  "paginate",
];
// The lexer does not keep quotes, so a quoted glob is refused too. An expanded glob can turn a
// file named --output=config into a flag, and <stdin> is where xargs puts words nobody read.
const SHELL_SYNTAX = /[$`*?[{]|<stdin>/;
// Wrappers that only adjust priority, time or lookup; anything else may change user or arguments.
const INERT_WRAPPERS = new Set(["command", "nice", "timeout", "nohup", "time"]);

function unsafeFlag(sub: string, arg: string): boolean {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0] as string;
    return UNSAFE_LONG.some((u) => u.startsWith(name) || name.startsWith(u));
  }
  // -O reads an orderfile or names a pager, and -o writes the diff to a file.
  const writes = ["diff", "log", "show"].includes(sub) ? /^-[^-]*[oO]/ : /^-[^-]*O/;
  return writes.test(arg);
}

// Words the shell expands later cannot be judged from their text.
function safeArgs(sub: string, args: string[]): boolean {
  const end = args.indexOf("--");
  const flags = end < 0 ? args : args.slice(0, end);
  return flags.every((a) => !a.startsWith("-") || !unsafeFlag(sub, a));
}

const BRANCH_FLAGS = new Set([
  "--list",
  "-a",
  "-r",
  "-v",
  "-vv",
  "--show-current",
  "--contains",
  "--merged",
  "--no-merged",
]);
const VALUE_FLAGS = new Set(["--contains", "--merged", "--no-merged", "--format"]);

// A bare word is a branch to create, unless a listing flag turns it into a pattern or a commit.
function listOnly(args: string[], allowed: (a: string) => boolean): boolean {
  let positional = false;
  let listing = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("-")) positional = true;
    else if (a === "--list" || a === "-l") listing = true;
    else if (!allowed(a)) return false;
    else if (VALUE_FLAGS.has(a)) i++;
  }
  return !positional || listing || args.some((a) => VALUE_FLAGS.has(a));
}

const branch = (args: string[]): boolean =>
  listOnly(args, (a) => BRANCH_FLAGS.has(a) || a.startsWith("--format="));

const tag = (args: string[]): boolean =>
  args.length === 0 ||
  (["-l", "--list"].includes(args[0] as string) && listOnly(args, () => false));

function remote(args: string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === "-v")) return true;
  return args.length === 2 && args[0] === "get-url" && !(args[1] as string).startsWith("-");
}

const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp"]);
const CONFIG_FLAGS = new Set([
  "--show-origin",
  "--show-scope",
  "--local",
  "--global",
  "--worktree",
]);

// `--list` prints every value, including remote URLs and helper settings that can hold credentials.
function config(args: string[]): boolean {
  return (
    CONFIG_READS.has(args[0] as string) &&
    args.slice(1).every((a) => !a.startsWith("-") || CONFIG_FLAGS.has(a))
  );
}

const HEAD_ONLY: Record<string, (rest: string[]) => boolean> = {
  worktree: (rest) => rest[0] === "list" && rest.slice(1).every((a) => a === "--porcelain"),
  stash: (rest) => rest[0] === "list" && safeArgs("stash", rest),
};

const PLAIN = new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "rev-list",
  "merge-base",
  "show-ref",
]);

interface Parsed {
  sub: string;
  rest: string[];
}

// `-c`, `--git-dir`, `--exec-path`, `-p` and every option not listed here make the line non-read.
// Another directory may be an embedded repository whose config names programs git then runs, so
// only the task root itself counts.
function isRoot(dir: string, scope: Scope): boolean {
  const abs = resolvePath(dir, scope);
  if (abs === null) return false;
  try {
    return realpathSync(abs) === realpathSync(scope.root);
  } catch {
    return false;
  }
}

function parseGlobals(argv: string[], scope: Scope): Parsed | null {
  let i = 1;
  for (; i < argv.length && (argv[i] as string).startsWith("-"); i++) {
    const a = argv[i] as string;
    if (a === "-C") {
      if (!isRoot(argv[++i] ?? "", scope)) return null;
    } else if (!["--no-pager", "-P", "--no-optional-locks"].includes(a)) return null;
  }
  return { sub: argv[i] ?? "", rest: argv.slice(i + 1) };
}

const SPECIAL: Record<string, (r: string[]) => boolean> = {
  ...HEAD_ONLY,
  branch,
  tag,
  remote,
  config,
};

export function isReadOnlyGit(cmd: Cmd, scope: Scope): boolean {
  const argv = cmd.argv;
  if (argv[0] !== "git" || !cmd.wrappers.every((w) => INERT_WRAPPERS.has(w))) return false;
  if (argv.some((a) => SHELL_SYNTAX.test(a))) return false;
  const parsed = parseGlobals(argv, scope);
  if (parsed === null) return false;
  const { sub, rest } = parsed;
  if (PLAIN.has(sub)) return safeArgs(sub, rest);
  const check = Object.hasOwn(SPECIAL, sub) ? SPECIAL[sub] : undefined;
  return check?.(rest) === true;
}
