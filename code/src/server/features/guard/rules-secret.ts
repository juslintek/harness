import { basename, join, resolve } from "node:path";
import {
  ask,
  type Ctx,
  deny,
  isInside,
  type L1Result,
  parseOpts,
  resolvePath,
  type Scope,
} from "./rules-core";
import { base, type Cmd } from "./shell";

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GLOB = /[*?[]/;
const SECRET_PATHS = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".gnupg",
  ".netrc",
  "Library/Keychains",
  ".docker/config.json",
  ".kube",
  ".git-credentials",
  ".npmrc",
  ".config/gcloud",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".harness/secrets.json",
];

function secretLocations(scope: Scope): string[] {
  const home = resolve(scope.home);
  const locations = SECRET_PATHS.map((p) => join(home, p));
  if (scope.harnessHome) locations.push(join(resolve(scope.harnessHome), "secrets.json"));
  return locations;
}
// A word we cannot resolve but that still names a credential location is not safe to pass.
const SECRET_WORD = /\.ssh|\.aws|\.gnupg|\.netrc|\.config\/gh|Keychains|\.git-credentials/i;
const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// curl `-d @file`, `-d@file`, `--data=@file`, `-F name=@file` hide the path behind a prefix.
function candidates(raw: string): string[] {
  const stripped = [
    raw,
    raw.replace(/^-{1,2}[\w-]*=/, ""),
    raw.replace(/^-[A-Za-z](?=[@~/$])/, ""),
    raw.replace(/^[\w.-]+=/, ""),
    raw.replace(/^[^/\s:]+:/, ""),
  ];
  return [...new Set(stripped.flatMap((c) => [c, c.replace(/^@/, "")]))];
}

function segmentMatches(pattern: string, literal: string): boolean {
  if (!GLOB.test(pattern)) return pattern.toLowerCase() === literal.toLowerCase();
  if (literal.startsWith(".") && !pattern.startsWith(".")) return false;
  const re = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  try {
    return new RegExp(`^${re}$`, "i").test(literal);
  } catch {
    return true;
  }
}

// APFS is case-insensitive by default, and a glob segment may expand to the credential directory.
function underSecret(abs: string, secret: string): boolean {
  const want = secret.split("/");
  const got = abs.split("/");
  return got.length >= want.length && want.every((seg, i) => segmentMatches(got[i] as string, seg));
}

function isSecretCandidate(candidate: string, scope: Scope): boolean {
  if (/\/proc\/[^/]+\/environ$/.test(candidate)) return true;
  const abs = resolvePath(candidate, scope);
  if (abs === null) return SECRET_WORD.test(candidate);
  if (secretLocations(scope).some((secret) => underSecret(abs, secret))) return true;
  return /^\.env/i.test(basename(abs)) && !isInside(abs, scope);
}

export function isSecretPath(raw: string, scope: Scope): boolean {
  return candidates(raw).some((c) => isSecretCandidate(c, scope));
}

function dumpsEnvironment(name: string, args: string[]): boolean {
  const flagsOnly = args.every((a) => ASSIGN.test(a) || a.startsWith("-"));
  if (name === "env" || name === "printenv") return flagsOnly;
  if (name === "set") return args.length === 0;
  return ["export", "declare", "typeset"].includes(name) && args.every((a) => a.startsWith("-"));
}

export function secrets(cmd: Cmd, scope: Scope): L1Result | null {
  const name = base(cmd.argv[0]);
  const args = cmd.argv.slice(1);
  if (dumpsEnvironment(name, args)) {
    return deny("secret.env-dump", "dumps the whole environment", "secret");
  }
  if (name === "printenv" && args.some((a) => SENSITIVE_NAME.test(a))) {
    return deny("secret.env-var", "reads a credential variable", "secret");
  }
  if (name === "security" && args.some((a) => /^(find-.*password|dump-keychain)$/.test(a))) {
    return deny("secret.keychain", "reads the keychain", "secret");
  }
  const words = [...args, ...cmd.assigns, ...cmd.redirects.map((r) => r.path)];
  const hit = words.find((w) => isSecretPath(w, scope));
  return hit ? deny("secret.path", `${hit} is a credential location`, "secret") : null;
}

const SWEEP_ALWAYS = /^(rg|ag|ack|zip|ditto|rsync|scp)$/;
const EXFIL = /^(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp)$/;
const FIND_EXEC = ["-exec", "-execdir", "-ok", "-okdir"];

function coversSecret(abs: string, scope: Scope): boolean {
  const prefix = abs === "/" ? "/" : `${abs}/`;
  return secretLocations(scope).some((secret) => secret === abs || secret.startsWith(prefix));
}

function recursiveRead(name: string, cmd: Cmd, o: ReturnType<typeof parseOpts>): boolean {
  if (/^(e|f)?grep$/.test(name))
    return ["r", "R"].some((f) => o.short.has(f)) || o.long.has("recursive");
  if (name === "cp") return ["r", "R", "a"].some((f) => o.short.has(f)) || o.long.has("recursive");
  if (name === "tar") return o.short.has("c") || /^[a-zA-Z]*c/.test(cmd.argv[1] ?? "");
  if (name === "find") return cmd.argv.some((a) => FIND_EXEC.includes(a)) || cmd.piped;
  return SWEEP_ALWAYS.test(name);
}

// Walking a tree that contains credentials reads them even though no secret path is named.
export function sweep(cmd: Cmd, scope: Ctx): L1Result | null {
  const name = base(cmd.argv[0]);
  const o = parseOpts(cmd.argv.slice(1));
  if (!recursiveRead(name, cmd, o)) return null;
  const searcher = /^(e|f)?grep$|^(rg|ag|ack)$/.test(name);
  const targets = searcher && o.rest.length <= 1 ? [...o.rest, "."] : o.rest;
  const hit = targets.some((t) => {
    const abs = resolvePath(t, scope);
    return abs !== null && coversSecret(abs, scope);
  });
  if (!hit) return null;
  const leaves =
    (cmd.piped && cmd.after.some((c) => EXFIL.test(base(c.argv[0])))) ||
    cmd.argv.some((a) => EXFIL.test(a));
  return leaves
    ? deny("secret.sweep-exfil", "a tree holding credentials is read and sent out", "secret")
    : ask("secret.sweep", "reads a directory tree that holds credentials", "secret");
}
