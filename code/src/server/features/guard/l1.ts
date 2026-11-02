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

function defaultCategory(names: string[]): Category {
  if (names.some((n) => NETWORK.has(n))) return "network";
  return names.length > 0 && names.every((n) => READ_ONLY.has(n)) ? "read" : "shell";
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
  const names = cmds.map((c) => base(c.argv[0])).filter(Boolean);
  return strictest(cmds, scope) ?? allow(null, "no rule matched", defaultCategory(names));
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
    return abs === null || !isInside(abs, scope);
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
// execute with no command, which L1 would otherwise ask about.
const HARNESS_TOOL = /^mcp(__|\.)harness(__|\.)/;

export function evaluateL1(action: ActionRequest, scope: Scope): L1Result {
  if (action.command === undefined && action.toolName && HARNESS_TOOL.test(action.toolName)) {
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
