import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type PackageEnv = Record<string, string | undefined>;

interface ResolveOpts {
  execPath?: string;
  compiled?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

// Bun compiled executables resolve import.meta.dir under /$bunfs (or B:/~BUN on Windows).
export function isCompiledBinary(dir: string = import.meta.dir): boolean {
  return dir.startsWith("/$bunfs") || dir.startsWith("B:/~BUN");
}

export function guardHookArg(scriptPath: string, compiled: boolean = isCompiledBinary()): string {
  return !existsSync(scriptPath) && compiled ? "guard-hook" : scriptPath;
}

function uniqueDirs(execPath: string): string[] {
  const dirs = [dirname(resolve(execPath))];
  try {
    const real = dirname(realpathSync(execPath));
    if (!dirs.includes(real)) dirs.push(real);
  } catch {
    // Missing or synthetic execPath in unit tests; stick to lexical dirname.
  }
  return dirs;
}

function trustedShareDir(env: PackageEnv): string | undefined {
  return env.HARNESS_SHARE_DIR && isAbsolute(env.HARNESS_SHARE_DIR)
    ? env.HARNESS_SHARE_DIR
    : undefined;
}

function packageRoots(
  execPath: string = process.execPath,
  env: PackageEnv = process.env,
): string[] {
  const roots: string[] = [];
  const push = (dir: string): void => {
    const full = resolve(dir);
    if (!roots.includes(full)) roots.push(full);
  };
  const share = trustedShareDir(env);
  if (share) push(share);
  for (const dir of uniqueDirs(execPath)) {
    push(dir);
    push(resolve(dir, "../share/harness"));
    push(resolve(dir, "../Resources"));
  }
  return roots;
}

export function resolveUiDist(
  env: PackageEnv = process.env,
  opts: ResolveOpts = {},
): string | undefined {
  if (env.HARNESS_UI_DIST) {
    return existsSync(join(env.HARNESS_UI_DIST, "index.html")) ? env.HARNESS_UI_DIST : undefined;
  }
  const compiled = opts.compiled ?? isCompiledBinary();
  if (!compiled && !trustedShareDir(env)) return undefined;
  for (const root of packageRoots(opts.execPath, env)) {
    const uiDir = join(root, "ui");
    if (existsSync(join(uiDir, "index.html"))) return uiDir;
  }
  return undefined;
}

export function resolveSeccompApplyPath(
  env: PackageEnv = process.env,
  opts: ResolveOpts = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return null;
  const arch = opts.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") return null;
  for (const root of packageRoots(opts.execPath, env)) {
    const candidate = join(root, "vendor", "seccomp", arch, "apply-seccomp");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolvePackagedAdapter(
  fileName: string,
  env: PackageEnv = process.env,
  opts: ResolveOpts = {},
): string | null {
  for (const root of packageRoots(opts.execPath, env)) {
    const candidate = join(root, "adapters", fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
