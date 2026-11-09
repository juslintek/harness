import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrate, openDb } from "../db/db";
import { migrations } from "../db/migrations";
import { readPort } from "../features/selfupdate/scratch";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`));
}

export function makeHome(): { home: string; db: Database } {
  const home = tempDir("selfupdate-home");
  const db = openDb(join(home, "harness.db"));
  migrate(db, migrations);
  return { home, db };
}

async function sh(cwd: string, ...argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
}

// A repo shaped like the harness checkout: the app lives under code/.
export async function makeRepo(version: string): Promise<string> {
  const repo = tempDir("selfupdate-repo");
  await sh(repo, "git", "init", "-q", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@example.test");
  await sh(repo, "git", "config", "user.name", "t");
  await sh(repo, "mkdir", "code");
  writeFileSync(join(repo, "code", "package.json"), JSON.stringify({ version }));
  await sh(repo, "git", "add", ".");
  await sh(repo, "git", "commit", "-q", "-m", "init");
  return repo;
}

// Commits `files` on `branch` (created from the current main on first use) and goes back to main.
export async function branchWith(
  repo: string,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  const exists = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", branch], { cwd: repo });
  await sh(repo, "git", "checkout", "-q", ...(exists.exitCode === 0 ? [] : ["-b"]), branch);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  await sh(repo, "git", "add", "-A");
  await sh(repo, "git", "commit", "-q", "-m", `change ${Object.keys(files).join(" ")}`);
  await sh(repo, "git", "checkout", "-q", "main");
}

export function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export async function liveServer(
  binary: string,
  home: string,
): Promise<{ proc: Bun.Subprocess<"ignore", "pipe", "pipe">; port: number }> {
  const proc = Bun.spawn([binary], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HARNESS_HOME: home, HARNESS_PORT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { proc, port: await readPort(proc) };
}

export async function versionAt(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  return ((await res.json()) as { version: string }).version;
}

// Servers a swap starts are detached, so tests stop them through the pid in the home's lock.
export function killHomeServer(home: string): void {
  try {
    process.kill(Number.parseInt(readFileSync(join(home, "harness.lock"), "utf8"), 10), "SIGKILL");
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      (err as NodeJS.ErrnoException).code !== "ESRCH"
    )
      throw err;
  }
}
