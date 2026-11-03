import { realpathSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_TOOL_NAMES } from "../../../shared/harness-tools";
import { isReadOnlyGit, plainEnv } from "./git-readonly";
import { ShellParseError } from "./lexer";
import { RULES } from "./rules";
import {
  allow,
  ask,
  type Category,
  type Ctx,
  deny,
  GIT_INTERNALS,
  isInside,
  type L1Result,
  resolvePath,
  type Scope,
} from "./rules-core";
import { recordFetch, runsFetched } from "./rules-net";
import { isSecretPath } from "./rules-secret";
import { base, type Cmd, parseCommands } from "./shell";

export type { Category, L1Result, Scope };

export interface ActionRequest {
  kind: "execute" | "read" | "edit" | "delete" | "fetch" | "other";
  command?: string;
  paths: string[];
  toolName?: string;
  title?: string;
}

const RANK = { allow: 0, ask: 2, deny: 3 } as const;
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "find",
  "stat",
  "file",
  "pwd",
  "echo",
  "printf",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "which",
  "jq",
]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "rsync", "ping", "dig", "nslookup"]);

// A rule hit beats the default allow; a deny beats everything and ends the scan.
function rank(r: L1Result): number {
  return RANK[r.verdict] + (r.verdict === "allow" && r.rule ? 1 : 0);
}

// Flags that make an otherwise read-only command run another program. GNU getopt accepts any
// unambiguous prefix of a long option, so `sort --comp=x` counts too.
const RUNS_PROGRAM: Record<string, string[]> = {
  rg: ["--pre", "--hostname-bin"],
  sort: ["--compress-program"],
  find: ["-exec", "-execdir", "-ok", "-okdir"],
};

function runsProgram(argv: string[]): boolean {
  const flags = RUNS_PROGRAM[base(argv[0])] ?? [];
  const isSort = base(argv[0]) === "sort";
  return argv.slice(1).some((arg) => {
    const flag = arg.split("=")[0] ?? "";
    return flags.some((f) => flag === f || (isSort && flag.length >= 4 && f.startsWith(flag)));
  });
}

// `git` is never read-only as a whole; only the forms isReadOnlyGit knows are.
function isReadCmd(cmd: Cmd, scope: Scope): boolean {
  if (!plainEnv(cmd)) return false;
  if (cmd.argv.length === 0) return true;
  const name = base(cmd.argv[0]);
  return name === "git" ? isReadOnlyGit(cmd.argv, scope) : READ_ONLY.has(name);
}

function defaultCategory(cmds: Cmd[], scope: Scope): Category {
  const names = cmds.map((c) => base(c.argv[0])).filter(Boolean);
  if (names.some((n) => NETWORK.has(n))) return "network";
  if (cmds.some((c) => runsProgram(c.argv))) return "shell";
  const reads = cmds.filter((c) => !c.mark).every((c) => isReadCmd(c, scope));
  return names.length > 0 && reads ? "read" : "shell";
}

// Working directory as the line runs: null once it depends on something unknowable.
interface Walk {
  cwd: string | null;
  scopes: Array<string | null>;
  dirs: Array<string | null>;
  fetched: Set<string>;
}

function changeDir(cmd: Cmd, scope: Ctx, w: Walk): void {
  const name = base(cmd.argv[0]);
  if (name === "popd") {
    w.cwd = w.dirs.pop() ?? null;
    return;
  }
  if (name === "source" || name === ".") w.cwd = null;
  if (name !== "cd" && name !== "pushd") return;
  const target = cmd.argv.slice(1).find((a) => !["-L", "-P", "--"].includes(a));
  if (name === "pushd") w.dirs.push(w.cwd);
  w.cwd = target === undefined ? scope.home : target === "-" ? null : resolvePath(target, scope);
}

function step(cmd: Cmd, scope: Scope, w: Walk): L1Result | null {
  if (cmd.mark) {
    if (cmd.mark === "(") w.scopes.push(w.cwd);
    else if (w.scopes.length > 0) w.cwd = w.scopes.pop() ?? null;
    return null;
  }
  const ctx: Ctx = { ...scope, cwd: w.cwd };
  let best: L1Result | null = runsFetched(cmd, ctx, w.fetched);
  for (const rule of RULES) {
    const hit = rule(cmd, ctx);
    if (hit && (!best || rank(hit) > rank(best))) best = hit;
  }
  recordFetch(cmd, ctx, w.fetched);
  changeDir(cmd, ctx, w);
  return best;
}

function strictest(cmds: Cmd[], scope: Scope): L1Result | null {
  const w: Walk = { cwd: scope.root, scopes: [], dirs: [], fetched: new Set() };
  let best: L1Result | null = null;
  for (const cmd of cmds) {
    const hit = step(cmd, scope, w);
    if (hit && (!best || rank(hit) > rank(best))) best = hit;
  }
  return best;
}

function evaluateShell(command: string | undefined, scope: Scope): L1Result {
  if (!command?.trim()) return ask("shell.empty", "no command to evaluate");
  let cmds: Cmd[];
  try {
    cmds = parseCommands(command);
  } catch (e) {
    if (e instanceof ShellParseError)
      return ask("shell.unparseable", `cannot parse command: ${e.message}`);
    throw e;
  }
  return strictest(cmds, scope) ?? allow(null, "no rule matched", defaultCategory(cmds, scope));
}

// A symlink inside the skills dir can point anywhere, so compare real paths, not the lexical ones.
function inInstalledSkills(abs: string, scope: Scope): boolean {
  try {
    const skills = realpathSync(join(scope.home, ".agents/skills"));
    return isInside(realpathSync(abs), { ...scope, root: skills });
  } catch {
    return false;
  }
}

function evaluatePaths(action: ActionRequest, scope: Scope): L1Result {
  if (action.paths.length === 0) return ask("path.none", "request names no path", "other");
  const category: Category =
    action.kind === "read" ? "read" : action.kind === "delete" ? "delete" : "edit";
  if (action.kind === "read") {
    const secret = action.paths.find((p) => isSecretPath(p, scope));
    if (secret) return deny("secret.path", `${secret} is a credential location`, "secret");
  }
  const outside = action.paths.find((p) => {
    const abs = resolvePath(p, scope);
    if (abs === null) return true;
    // Codex reads its installed skills from here on every run; reading them is harmless, editing stays denied.
    if (action.kind === "read" && inInstalledSkills(abs, scope)) return false;
    return !isInside(abs, scope);
  });
  if (outside !== undefined) {
    return action.kind === "read"
      ? ask("read.outside-root", `${outside} is outside the task root`, category)
      : deny("write.outside-root", `${outside} is outside the task root`, category);
  }
  if (
    action.kind !== "read" &&
    action.paths.some((p) => GIT_INTERNALS.test(resolvePath(p, scope) ?? ""))
  ) {
    return deny("write.git-internals", "git hooks and config run code", category);
  }
  return allow(null, "inside the task root", category);
}

export function splitCommands(cmd: string): string[][] {
  return parseCommands(cmd)
    .map((c) => c.argv)
    .filter((argv) => argv.length > 0);
}

// Claude names its MCP tools mcp__harness__x and Codex mcp.harness.x; Codex files them under kind
// execute with no command, which L1 would otherwise ask about. ACP tool names are display titles
// that can carry model-chosen text, so the whole name must be a registered tool, and the action
// must name no path and no command.
const HARNESS_TOOLS = new Set(
  HARNESS_TOOL_NAMES.flatMap((n) => [`mcp__harness__${n}`, `mcp.harness.${n}`]),
);

function isHarnessTool(action: ActionRequest): boolean {
  return (
    action.command === undefined &&
    action.paths.length === 0 &&
    (action.kind === "other" || action.kind === "execute") &&
    action.toolName !== undefined &&
    HARNESS_TOOLS.has(action.toolName)
  );
}

export function evaluateL1(action: ActionRequest, scope: Scope): L1Result {
  if (isHarnessTool(action)) {
    return allow(null, "harness tool, scoped by the run token", "other");
  }
  switch (action.kind) {
    case "execute":
      return evaluateShell(action.command, scope);
    case "read":
    case "edit":
    case "delete":
      return evaluatePaths(action, scope);
    case "fetch":
      return ask("fetch.any", "network fetch needs approval", "network");
    default:
      // Claude loads the harness MCP tool schemas through ToolSearch, which only reads tool
      // definitions. The harness's own tools are already limited by the run token's scopes.
      // Asking for either would stop every unattended agent before its first board call.
      if (action.toolName === "ToolSearch") return allow(null, "tool schema lookup", "other");
      return ask("other.any", "unclassified action", "other");
  }
}
