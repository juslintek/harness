/*
 * Rule set ported from cc-safety-net (https://github.com/kenryu42/claude-code-safety-net),
 * adapted to the harness scope model.
 *
 * MIT License
 *
 * Copyright (c) 2026 J Liew
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { container } from "./rules-container";
import {
  allow,
  ask,
  type Ctx,
  deny,
  isInside,
  parseOpts,
  type Rule,
  resolvePath,
} from "./rules-core";
import { dynamicName, escalate, inlineCode, sourceOutside, stdinScript } from "./rules-exec";
import { gitEnvironment, gitRule } from "./rules-git";
import { network } from "./rules-net";
import { secrets, sweep } from "./rules-secret";
import { perms, writes } from "./rules-write";
import { base } from "./shell";

const BYPASS_ASSIGN = /^(\w*_BYPASS|SAFETY_NET_\w*|DCG_\w*|HARNESS_\w*)=/;
const BYPASS_NAME = /^(\w*_BYPASS|SAFETY_NET_\w*|DCG_\w*|HARNESS_\w*)(=|$)/;
const ENV_SETTERS = new Set(["export", "declare", "typeset", "readonly", "local", "env", "read"]);
// Commands that remove or overwrite their operands whatever flags they carry.
const ALWAYS_DESTRUCTIVE = new Set([
  "unlink",
  "shred",
  "srm",
  "rmdir",
  "truncate",
  "rimraf",
  "del",
  "del-cli",
]);
const INJECTION = /^(BASH_ENV|ENV|PROMPT_COMMAND|CDPATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+)=/;

const envTricks: Rule = (cmd) => {
  const name = base(cmd.argv[0]);
  const bypass =
    cmd.assigns.some((w) => BYPASS_ASSIGN.test(w)) ||
    (ENV_SETTERS.has(name) && cmd.argv.slice(1).some((w) => BYPASS_NAME.test(w)));
  if (bypass) return deny("env.bypass", "setting a guard bypass variable is blocked", "other");
  const injected = [...cmd.assigns, ...(ENV_SETTERS.has(name) ? cmd.argv.slice(1) : [])];
  return (
    gitEnvironment(cmd.assigns, cmd.argv, name) ??
    (injected.some((w) => INJECTION.test(w))
      ? ask("env.injection", "this variable makes a shell load or redirect code", "other")
      : null)
  );
};

function rootItself(abs: string, raw: string, root: string): boolean {
  return abs === root || /(^|\/)\.\*$/.test(raw);
}

type RmPlace = "unknown" | "cwd" | "outside" | "root" | "inside";

function rmPlace(p: string, scope: Ctx): RmPlace {
  const abs = resolvePath(p, scope);
  if (abs === null) {
    const known = scope.cwd === null && resolvePath(p, scope, scope.root) !== null;
    return known ? "cwd" : "unknown";
  }
  if (!isInside(abs, scope)) return "outside";
  return rootItself(abs, p, scope.root) ? "root" : "inside";
}

const rm: Rule = (cmd, scope) => {
  const name = base(cmd.argv[0]);
  if (name !== "rm" && !ALWAYS_DESTRUCTIVE.has(name)) return null;
  const o = parseOpts(cmd.argv.slice(1));
  const heavy =
    name !== "rm" ||
    ["r", "R", "f"].some((f) => o.short.has(f)) ||
    o.long.has("recursive") ||
    o.long.has("force");
  const where = o.rest.map((p) => rmPlace(p, scope));
  const bad = o.rest[where.findIndex((w) => w === "outside" || (heavy && w === "unknown"))];
  if (where.some((w) => w === "outside") || (heavy && where.includes("unknown"))) {
    return deny(
      "rm.outside-root",
      `${bad} is outside or cannot be placed in the task root`,
      "delete",
    );
  }
  if (heavy && !o.long.has("find") && where.includes("root")) {
    return ask("rm.task-root", "removes the whole task root", "delete");
  }
  if (where.includes("cwd"))
    return ask("rm.cwd-unknown", "working directory is not known", "delete");
  return where.includes("unknown")
    ? ask("rm.unresolvable-path", "rm target depends on a variable", "delete")
    : allow("rm.in-root", "delete inside the task root", "delete");
};

const disk: Rule = (cmd) => {
  const name = base(cmd.argv[0]);
  const sub = cmd.argv[1] ?? "";
  if (name === "dd" && cmd.argv.some((a) => a.startsWith("of=/dev/"))) {
    return deny("disk.dd-device", "dd writes to a device");
  }
  if (/^(mkfs|newfs)/.test(name)) return deny("disk.mkfs", "formats a filesystem");
  const erase = /^(erase|zero|secure|partition|repartition|reformat)/i.test(sub);
  if (
    name === "diskutil" &&
    (erase || (sub === "apfs" && /^(delete|erase)/i.test(cmd.argv[2] ?? "")))
  ) {
    return deny("disk.diskutil-erase", "diskutil destroys volumes");
  }
  return null;
};

export const RULES: Rule[] = [
  envTricks,
  dynamicName,
  container,
  sweep,
  (cmd, scope) => (base(cmd.argv[0]) === "git" ? gitRule(cmd.argv, scope) : null),
  rm,
  disk,
  perms,
  network,
  secrets,
  writes,
  inlineCode,
  stdinScript,
  sourceOutside,
  escalate,
];
