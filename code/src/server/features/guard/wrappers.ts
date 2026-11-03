import { ShellParseError } from "./lexer";

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Wrapper {
  argOpts: string[];
  skip: number;
  assigns: boolean;
}

const none = (skip = 0): Wrapper => ({ argOpts: [], skip, assigns: false });

const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    argOpts: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"],
    skip: 0,
    assigns: true,
  },
  doas: { argOpts: ["-u", "-C"], skip: 0, assigns: false },
  env: { argOpts: ["-u", "-C", "-S"], skip: 0, assigns: true },
  nice: { argOpts: ["-n"], skip: 0, assigns: false },
  timeout: { argOpts: ["-s", "-k"], skip: 1, assigns: false },
  xargs: { argOpts: ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"], skip: 0, assigns: false },
  exec: { argOpts: ["-a"], skip: 0, assigns: false },
  caffeinate: { argOpts: ["-t", "-w"], skip: 0, assigns: false },
  stdbuf: { argOpts: ["-i", "-o", "-e"], skip: 0, assigns: false },
  flock: { argOpts: ["-w", "-E"], skip: 1, assigns: false },
  ionice: { argOpts: ["-c", "-n", "-p"], skip: 0, assigns: false },
  taskset: { argOpts: ["-c"], skip: 1, assigns: false },
  chrt: none(1),
  arch: none(),
  command: none(),
  nohup: none(),
  time: none(),
  builtin: none(),
  setsid: none(),
  busybox: none(),
  "npm x": { argOpts: ["-p", "--package", "-c", "--call"], skip: 0, assigns: false },
  "pnpm exec": { argOpts: ["-c"], skip: 0, assigns: false },
  "yarn exec": none(),
  "npm exec": { argOpts: ["-p", "--package", "-c", "--call"], skip: 0, assigns: false },
  "pnpm dlx": { argOpts: ["-p", "--package"], skip: 0, assigns: false },
  "yarn dlx": { argOpts: ["-p", "--package"], skip: 0, assigns: false },
  "bun x": none(),
  "uv run": {
    argOpts: ["--with", "--python", "-p", "--extra", "--group"],
    skip: 0,
    assigns: false,
  },
  "pipx run": { argOpts: ["--spec", "--python"], skip: 0, assigns: false },
  "poetry run": none(),
  npx: { argOpts: ["-p", "--package", "-c", "--call"], skip: 0, assigns: false },
  bunx: none(),
  uvx: { argOpts: ["--with", "--from", "--python", "-p"], skip: 0, assigns: false },
  script: none(1),
};

const SHELLS: Set<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Options that move the wrapped command to another directory; the cwd tracker cannot follow them.
const CHDIR: Record<string, string> = { env: "-C", sudo: "-D" };
const COMPOUND = new Set([
  "npm exec",
  "npm x",
  "pnpm exec",
  "yarn exec",
  "pnpm dlx",
  "yarn dlx",
  "bun x",
  "uv run",
  "pipx run",
  "poetry run",
]);
// `pnpm rimraf ~` and `yarn rimraf ~` run a local bin when the word is not a package-manager subcommand.
const PM_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "run",
  "test",
  "t",
  "start",
  "build",
  "init",
  "publish",
  "pack",
  "link",
  "unlink",
  "list",
  "ls",
  "why",
  "outdated",
  "audit",
  "store",
  "config",
  "prune",
  "rebuild",
  "import",
  "fetch",
  "patch",
  "deploy",
  "create",
  "env",
  "dlx",
  "exec",
  "cache",
  "info",
  "version",
  "workspace",
  "workspaces",
  "global",
  "login",
  "logout",
  "whoami",
  "help",
  "dedupe",
  "licenses",
  "ci",
  "set",
  "bin",
  "root",
  "check",
  "lint",
]);
const COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

export function base(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

// Value-taking option, either `-n 5` or attached `-n5`; returns the index of the last token consumed.
function takeOption(
  argv: string[],
  i: number,
  spec: Wrapper,
  vals: Record<string, string>,
): number {
  const a = argv[i] as string;
  const opt = spec.argOpts.find((o) => a.startsWith(o));
  if (!opt) return i;
  if (a.length > opt.length) vals[opt] = a.slice(opt.length);
  else vals[opt] = argv[i + 1] ?? "";
  return a.length > opt.length ? i : i + 1;
}

function scanOptions(
  argv: string[],
  spec: Wrapper,
  from: number,
): { next: number; assigns: string[]; vals: Record<string, string> } {
  const assigns: string[] = [];
  const vals: Record<string, string> = {};
  let i = from;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (spec.assigns && ASSIGN.test(a)) assigns.push(a);
    else if (!a.startsWith("-") || a.length === 1) break;
    else i = takeOption(argv, i, spec, vals);
  }
  return { next: i, assigns, vals };
}

// xargs appends stdin to the command; model it as an unresolvable path so rules treat it as unknown.
function markStdin(rest: string[], replstr: string | undefined): string[] {
  if (!replstr) return [...rest, "<stdin>"];
  const replaced = rest.map((w) => w.replaceAll(replstr, "<stdin>"));
  return replaced.some((w, k) => w !== rest[k]) ? replaced : [...rest, "<stdin>"];
}

function rejectChdir(name: string, opts: string[], vals: Record<string, string>): void {
  const flag = CHDIR[name];
  if ((flag && vals[flag] !== undefined) || opts.some((a) => /^--(chdir|directory|cwd)/.test(a))) {
    throw new ShellParseError(`${name} changes the working directory`);
  }
}

// Wrapper table key and the index where its options start (`npm exec` skips two words).
function wrapperKey(argv: string[]): { name: string; plain: string; from: number } {
  const plain = base(argv[0]);
  const sub = argv[1] ?? "";
  if (COMPOUND.has(`${plain} ${sub}`)) return { name: `${plain} ${sub}`, plain, from: 2 };
  const bin = ["pnpm", "yarn"].includes(plain) && sub !== "" && !sub.startsWith("-");
  const runsBin = bin && !PM_SUBCOMMANDS.has(sub);
  return { name: runsBin ? `${plain} exec` : plain, plain, from: 1 };
}

function finishRest(name: string, rest: string[], vals: Record<string, string>): string[] {
  const call = vals["-c"] ?? vals["--call"];
  if (call !== undefined && /^(npx|npm x|npm exec|pnpm exec)$/.test(name))
    return ["sh", "-c", call];
  if (name === "env" && vals["-S"]) return [...vals["-S"].split(/\s+/).filter(Boolean), ...rest];
  return name === "xargs" ? markStdin(rest, vals["-I"]) : rest;
}

export function unwrap(argv: string[]): { rest: string[]; assigns: string[]; name: string } | null {
  const { name, from } = wrapperKey(argv);
  if (!Object.hasOwn(WRAPPERS, name)) return null;
  if (name === "command" && (argv[1] === "-v" || argv[1] === "-V")) return null;
  if ((name === "script" || name === "flock") && argv.some((a) => COMMAND_FLAG.test(a)))
    return null;
  const spec = WRAPPERS[name] as Wrapper;
  const { next, assigns, vals } = scanOptions(argv, spec, from);
  rejectChdir(name, argv.slice(0, next), vals);
  const rest = finishRest(name, argv.slice(next + spec.skip), vals);
  return rest.length ? { rest, assigns, name } : null;
}

export function runsScript(name: string): boolean {
  return SHELLS.has(name) || ["eval", "su", "script", "flock"].includes(name);
}

function dashC(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-o" || a === "-O") i++;
    else if (COMMAND_FLAG.test(a)) return argv[i + 1] ?? null;
    else if (!a.startsWith("-") && !a.startsWith("+")) return null;
  }
  return null;
}

export function shellScript(name: string, argv: string[]): string | null {
  if (name === "eval") return argv.slice(1).join(" ");
  if (!["su", "script", "flock"].includes(name)) return dashC(argv);
  const i = argv.findIndex((a) => COMMAND_FLAG.test(a) || a === "--command");
  return i < 0 ? null : (argv[i + 1] ?? null);
}
