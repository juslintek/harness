import { isAbsolute, resolve } from "node:path";
import type { Cmd } from "./shell";

export type Category =
  | "read"
  | "edit"
  | "shell"
  | "network"
  | "delete"
  | "git_push"
  | "secret"
  | "other";

export interface Scope {
  root: string;
  home: string;
  defaultBranch: string;
}

export interface L1Result {
  verdict: "allow" | "ask" | "deny";
  rule: string | null;
  reason: string;
  category: Category;
}

export function deny(rule: string, reason: string, category: Category = "shell"): L1Result {
  return { verdict: "deny", rule, reason, category };
}

export function ask(rule: string, reason: string, category: Category = "shell"): L1Result {
  return { verdict: "ask", rule, reason, category };
}

export function allow(rule: string | null, reason: string, category: Category): L1Result {
  return { verdict: "allow", rule, reason, category };
}

const HOME_PREFIX = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;
// Shell expands these before the program sees them, so the literal text says nothing about the target.
const UNKNOWN_WORD = /[$`]|^<\(|<stdin>|^~[^/]|\{[^}]*(,|\.\.)[^}]*\}/;

export const GIT_INTERNALS: RegExp = /(^|\/)\.git(\/(hooks|config)(\/|$)|$)/;

export type Ctx = Scope & { cwd?: string | null };

export type Rule = (cmd: Cmd, scope: Ctx) => L1Result | null;

function baseDir(scope: Ctx): string | null {
  return scope.cwd === undefined ? scope.root : scope.cwd;
}

// Null means the path depends on something we cannot evaluate statically ($VAR, ~user, brace
// expansion, substitution, xargs stdin, or a relative path after a cd to an unknown place).
export function resolvePath(raw: string, scope: Ctx, base?: string | null): string | null {
  const expanded = raw.replace(HOME_PREFIX, scope.home);
  if (UNKNOWN_WORD.test(expanded)) return null;
  if (isAbsolute(expanded)) return resolve(expanded);
  const dir = base === undefined ? baseDir(scope) : base;
  return dir === null ? null : resolve(dir, expanded);
}

export function isInside(abs: string, scope: Scope): boolean {
  const root = resolve(scope.root);
  return abs === root || abs.startsWith(root === "/" ? "/" : `${root}/`);
}

export interface Opts {
  short: Set<string>;
  long: Set<string>;
  rest: string[];
}

export function parseOpts(args: string[]): Opts {
  const opts: Opts = { short: new Set(), long: new Set(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      opts.rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) opts.long.add(a.slice(2).split("=")[0] as string);
    else if (a.startsWith("-") && a.length > 1) for (const ch of a.slice(1)) opts.short.add(ch);
    else opts.rest.push(a);
  }
  return opts;
}
