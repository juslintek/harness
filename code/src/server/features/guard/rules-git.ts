import {
  ask,
  deny,
  isInside,
  type L1Result,
  parseOpts,
  resolvePath,
  type Scope,
} from "./rules-core";

interface GitCall {
  cfg: string[];
  dir: string | null;
  sub: string;
  rest: string[];
}

type Handler = (g: GitCall, scope: Scope) => L1Result | null;

const VALUE_FLAGS = ["--git-dir", "--work-tree", "--namespace", "--exec-path"];

// Global option before the subcommand; returns the index of the last token consumed.
function globalOption(argv: string[], i: number, g: GitCall): number {
  const a = argv[i] as string;
  if (a === "-c" || a === "--config-env") g.cfg.push(argv[i + 1] ?? "");
  else if (a.startsWith("--config-env=")) g.cfg.push(a.slice("--config-env=".length));
  else if (a === "-C") g.dir = argv[i + 1] ?? null;
  else if (!VALUE_FLAGS.includes(a)) return i;
  return i + 1;
}

function parseGit(argv: string[]): GitCall {
  const g: GitCall = { cfg: [], dir: null, sub: "", rest: [] };
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith("-")) i = globalOption(argv, i, g) + 1;
  g.sub = argv[i] ?? "";
  g.rest = argv.slice(i + 1);
  return g;
}

function push(g: GitCall, scope: Scope): L1Result | null {
  const o = parseOpts(g.rest);
  const force =
    o.short.has("f") ||
    ["force", "force-with-lease", "force-if-includes"].some((f) => o.long.has(f));
  if (force) return deny("git.push-force", "force push rewrites remote history");
  if (["mirror", "delete", "prune", "all"].some((f) => o.long.has(f)) || o.short.has("d")) {
    return deny("git.push-destructive", "push mode deletes or overwrites remote refs");
  }
  const refspecs = g.rest.some((a) => a.startsWith("--repo=")) ? o.rest : o.rest.slice(1);
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return deny("git.push-force", "+refspec forces the update");
    if (refspec.startsWith(":"))
      return deny("git.push-destructive", "empty source deletes the remote ref");
    const dst = refspec.slice(refspec.lastIndexOf(":") + 1).replace(/^refs\/heads\//, "");
    if (dst === scope.defaultBranch) {
      return deny("git.push-default-branch", `push to ${scope.defaultBranch} needs a manager`);
    }
  }
  return ask("git.push", "git push publishes commits", "git_push");
}

// Discarding uncommitted work: denied outside the task root, asked inside it.
function discard(g: GitCall, scope: Scope, paths: string[]): L1Result | null {
  if (!paths.length) return null;
  const base = g.dir === null ? scope.root : resolvePath(g.dir, scope);
  const outside =
    base === null ||
    !isInside(base, scope) ||
    paths.some((p) => {
      const abs = resolvePath(p, scope, base);
      return abs === null || !isInside(abs, scope);
    });
  return outside
    ? deny("git.discard-outside-root", "discards changes outside the task root")
    : ask("git.discard-changes", "discards uncommitted changes");
}

function checkout(g: GitCall, scope: Scope): L1Result | null {
  const sep = g.rest.indexOf("--");
  const head = parseOpts(sep < 0 ? g.rest : g.rest.slice(0, sep));
  if (head.short.has("f") || head.long.has("force")) {
    return deny("git.checkout-force", "forced checkout discards local changes");
  }
  return discard(g, scope, sep >= 0 ? g.rest.slice(sep + 1) : g.rest.filter((a) => a === "."));
}

function restore(g: GitCall, scope: Scope): L1Result | null {
  const o = parseOpts(g.rest);
  const staged = o.long.has("staged") || o.short.has("S");
  const worktree = o.long.has("worktree") || o.short.has("W");
  return staged && !worktree ? null : discard(g, scope, o.rest);
}

function branch(g: GitCall, scope: Scope): L1Result | null {
  const o = parseOpts(g.rest);
  const force =
    o.short.has("D") ||
    ((o.short.has("d") || o.long.has("delete")) && (o.short.has("f") || o.long.has("force")));
  if ((o.short.has("M") || o.short.has("m")) && o.rest.includes(scope.defaultBranch)) {
    return deny("git.branch-overwrite-default", `renaming over ${scope.defaultBranch} is blocked`);
  }
  const removes = force || o.short.has("d") || o.long.has("delete");
  if (removes && o.rest.includes(scope.defaultBranch)) {
    return deny("git.branch-delete-default", `deleting ${scope.defaultBranch} is blocked`);
  }
  return force ? ask("git.branch-force-delete", "force delete drops unmerged commits") : null;
}

const HANDLERS: Record<string, Handler> = {
  push,
  checkout,
  restore,
  branch,
  reset: (g) =>
    parseOpts(g.rest).long.has("hard") || parseOpts(g.rest).long.has("merge")
      ? deny("git.reset-hard", "hard reset discards local changes")
      : null,
  clean: (g) => {
    const o = parseOpts(g.rest);
    const dryRun = o.short.has("n") || o.long.has("dry-run");
    return (o.short.has("f") || o.long.has("force")) && !dryRun
      ? deny("git.clean-force", "git clean -f deletes untracked files")
      : null;
  },
  stash: (g) => (g.rest[0] === "clear" ? deny("git.stash-clear", "drops every stash") : null),
  "filter-branch": () => deny("git.filter-branch", "rewrites the whole history"),
  "filter-repo": () => deny("git.filter-branch", "rewrites the whole history"),
  config: (g) => {
    const o = parseOpts(g.rest);
    if (["get", "get-all", "list", "l", "unset"].some((f) => o.long.has(f) || o.short.has(f))) {
      return null;
    }
    const bad = o.rest.find((k, i) => i + 1 < o.rest.length && riskyConfig(k, o.rest[i + 1]));
    return bad ? configDeny(bad) : null;
  },
  "update-ref": (g) =>
    g.rest.includes("-d") ? deny("git.update-ref-delete", "deletes a ref without a trace") : null,
  "checkout-index": (g) =>
    g.rest.includes("-f") || g.rest.includes("--force")
      ? deny("git.checkout-force", "forced checkout-index overwrites local changes")
      : null,
  switch: (g) =>
    ["-f", "--force", "--discard-changes"].some((f) => g.rest.includes(f))
      ? deny("git.switch-force", "forced switch discards local changes")
      : null,
  worktree: (g) =>
    g.rest[0] === "remove" && (g.rest.includes("-f") || g.rest.includes("--force"))
      ? deny("git.worktree-force", "forced worktree removal drops uncommitted work")
      : null,
  reflog: (g) =>
    ["expire", "delete"].includes(g.rest[0] ?? "")
      ? deny("git.reflog-expire", "reflog is the recovery path")
      : null,
  gc: (g) =>
    g.rest.some((a) => /^--prune=now$/.test(a))
      ? deny("git.gc-prune-now", "prune now makes unreachable commits unrecoverable")
      : null,
  rm: (g) => {
    const o = parseOpts(g.rest);
    return o.short.has("f") || o.long.has("force")
      ? deny("git.rm-force", "forced git rm deletes files with local changes")
      : null;
  },
};

// Keys whose value makes git run an arbitrary program or load more config.
const RISKY_KEY =
  /^(core\.(hookspath|sshcommand|fsmonitor|pager|editor|gitproxy)|include\.path|includeif\..+|credential(\..+)?\.helper|filter\..+|diff\.external|uploadpack\.packobjectshook)$/i;
const GIT_ENV =
  /^(GIT_CONFIG_(?:PARAMETERS|GLOBAL|SYSTEM)|GIT_EXEC_PATH|GIT_SSH(?:_COMMAND)?|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_ASKPASS|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR|GIT_CONFIG_KEY_\d+)=(.*)$/s;

function riskyConfig(key: string, value: string | undefined): boolean {
  const k = key.split("=")[0] as string;
  if (/^alias\./i.test(k))
    return (key.includes("=") ? key.slice(k.length + 1) : (value ?? "")).startsWith("!");
  return RISKY_KEY.test(k);
}

function configDeny(key: string): L1Result {
  return deny("git.config-override", `git config ${key.split("=")[0]} can run arbitrary code`);
}

// Environment-based config injection: `GIT_CONFIG_KEY_0=core.hooksPath` or a program path variable.
export function gitEnvironment(assigns: string[], argv: string[], name: string): L1Result | null {
  const words = name === "env" ? [...assigns, ...argv.slice(1)] : assigns;
  for (const w of words) {
    const m = GIT_ENV.exec(w);
    if (!m) continue;
    const keyed = /^GIT_CONFIG_KEY_/.test(m[1] as string);
    if (!keyed || RISKY_KEY.test(m[2] as string) || /^alias\./i.test(m[2] as string)) {
      return deny("git.env-override", `${m[1]} makes git run attacker-chosen code`);
    }
  }
  return null;
}

export function gitRule(argv: string[], scope: Scope): L1Result | null {
  const g = parseGit(argv);
  const bad = g.cfg.find((c) => riskyConfig(c, undefined));
  if (bad) return configDeny(bad);
  return Object.hasOwn(HANDLERS, g.sub) ? (HANDLERS[g.sub]?.(g, scope) ?? null) : null;
}
