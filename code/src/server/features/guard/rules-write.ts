import {
  ask,
  type Ctx,
  deny,
  GIT_INTERNALS,
  isInside,
  type L1Result,
  parseOpts,
  type Rule,
  resolvePath,
} from "./rules-core";
import { isSecretPath } from "./rules-secret";
import { base, type Cmd } from "./shell";

const DEV_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const SOFT_WRITERS = new Set(["tee", "touch", "mkdir"]);
const REMOTE = /^[^/.][^/]*:/;

type Placement = "sink" | "internals" | "unknown" | "outside" | "inside";

function place(p: string, scope: Ctx): Placement {
  const abs = REMOTE.test(p) ? null : resolvePath(p, scope);
  if (abs === null) return "unknown";
  if (DEV_SINKS.has(abs)) return "sink";
  if (GIT_INTERNALS.test(abs)) return "internals";
  return isInside(abs, scope) ? "inside" : "outside";
}

// Destructive writes outside the task root are denied, softer ones are asked; unknown targets are asked.
function judge(paths: string[], destructive: boolean, scope: Ctx, label: string): L1Result | null {
  const where = paths.map((p) => place(p, scope));
  if (where.includes("internals")) {
    return deny("write.git-internals", "git hooks and config run code", "edit");
  }
  if (destructive && where.includes("outside")) {
    return deny("write.outside-root", `${label} changes files outside the task root`, "edit");
  }
  return where.includes("outside") || where.includes("unknown")
    ? ask("write.outside-root", `${label} writes where the guard cannot confirm the root`, "edit")
    : null;
}

function optionValue(argv: string[], short: string, long: string): string | undefined {
  const i = argv.findIndex((a) => a === short || a === long || a.startsWith(`${long}=`));
  if (i < 0) return undefined;
  return argv[i]?.includes("=") ? argv[i]?.split("=").slice(1).join("=") : argv[i + 1];
}

function copyLike(cmd: Cmd, name: string, scope: Ctx): L1Result | null {
  const rest = parseOpts(cmd.argv.slice(1)).rest;
  const dir = optionValue(cmd.argv, "-t", "--target-directory");
  const dest = dir === undefined ? rest.slice(-1) : [dir];
  if (name === "mv") return judge(rest, true, scope, name);
  if (name === "ln") {
    const o = parseOpts(cmd.argv.slice(1));
    const forced = o.short.has("f") || o.long.has("force");
    return judge(dest, forced, scope, name) ?? judge(rest.slice(0, 1), false, scope, name);
  }
  return judge(dest, true, scope, name);
}

function rsync(cmd: Cmd, scope: Ctx): L1Result | null {
  const o = parseOpts(cmd.argv.slice(1));
  const deleting = cmd.argv.some((a) => a.startsWith("--delete") || a === "--remove-source-files");
  return judge(o.rest.slice(-1), deleting, scope, "rsync");
}

// The first operand is the script (or the -e value), the rest are files edited in place.
function inPlaceTargets(cmd: Cmd): string[] {
  const o = parseOpts(cmd.argv.slice(1));
  if (!o.short.has("i") && !o.long.has("in-place")) return [];
  return o.rest.filter((a) => a !== "").slice(1);
}

function tar(cmd: Cmd, scope: Ctx): L1Result | null {
  const args = cmd.argv.slice(1);
  const bundled = args[0] && !args[0].startsWith("-") ? args[0] : "";
  const letters = bundled + args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
  const extract = /x/.test(letters) || args.includes("--extract") || args.includes("--get");
  const dirs: string[] = [];
  let cur: Ctx = scope;
  for (const [i, a] of args.entries()) {
    const dir =
      a === "-C" || a === "--directory" ? args[i + 1] : /^(-C|--directory=)(.+)/.exec(a)?.[2];
    if (dir !== undefined) {
      dirs.push(dir);
      const abs = resolvePath(dir, scope);
      cur = { ...scope, cwd: abs };
    } else if (!a.startsWith("-") && i > 0 && isSecretPath(a, cur)) {
      return deny("secret.path", `${a} is a credential location`, "secret");
    }
  }
  return extract ? judge(dirs.length ? dirs : ["."], true, scope, "tar") : null;
}

function dd(cmd: Cmd, scope: Ctx): L1Result | null {
  const outs = cmd.argv.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  return judge(outs, true, scope, "dd");
}

function redirects(cmd: Cmd, scope: Ctx): L1Result | null {
  const targets = cmd.redirects.filter((r) => r.op === ">").map((r) => r.path);
  return judge(targets, true, scope, "redirect");
}

export const writes: Rule = (cmd, scope) => {
  const name = base(cmd.argv[0]);
  const rest = parseOpts(cmd.argv.slice(1)).rest;
  const byName = (): L1Result | null => {
    if (SOFT_WRITERS.has(name)) return judge(rest, false, scope, name);
    if (["mv", "cp", "install", "ln"].includes(name)) return copyLike(cmd, name, scope);
    if (name === "rsync") return rsync(cmd, scope);
    if (name === "tar") return tar(cmd, scope);
    if (name === "dd") return dd(cmd, scope);
    if (["sed", "gsed", "perl"].includes(name))
      return judge(inPlaceTargets(cmd), true, scope, name);
    return null;
  };
  return redirects(cmd, scope) ?? byName();
};

export const perms: Rule = (cmd, scope) => {
  const name = base(cmd.argv[0]);
  if (!["chmod", "chown", "chgrp"].includes(name)) return null;
  const o = parseOpts(cmd.argv.slice(1));
  const recursive = o.short.has("R") || o.long.has("recursive");
  if (name === "chmod" && recursive && /^(0?777|a\+rwx|ugo\+rwx|o\+w)$/.test(o.rest[0] ?? "")) {
    return deny("perms.world-writable", "recursive world-writable chmod");
  }
  const hit = judge(o.rest, true, scope, name);
  return hit && { ...hit, rule: "perms.outside-root", category: "shell" };
};
