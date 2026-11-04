// Things a scenario needs around the server: a stub agent spec, a repo to run against, a process probe.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSpec } from "./server";

const FAKE_AGENT = resolve(import.meta.dir, "../fake-agent.ts");

export function fakeAgent(id: string, script: unknown[], marker: string): AgentSpec {
  return {
    id,
    name: id,
    lane: "acp",
    bin: process.execPath,
    args: [FAKE_AGENT, JSON.stringify(script), marker],
    versionArgs: [],
    loginProbe: null,
    loginArgs: null,
    modeOption: null,
    egress: [],
    stateWrite: [],
    weakerNetworkIsolation: false,
    claudeMeta: false,
  };
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

function git(args: string[], cwd: string): void {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=conf", "-c", "user.email=conf@example.test", ...args],
    {
      cwd,
      env: gitEnv(),
    },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

export function scratchRepo(): { path: string; remove: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "harness-conf-repo-")));
  git(["init", "-q", "-b", "main"], path);
  writeFileSync(join(path, "NOTES.md"), "# notes\n");
  git(["add", "."], path);
  git(["commit", "-q", "-m", "init"], path);
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

// Created on first use, for the same reason servers boot lazily.
export function lazyRepo(): { path: () => string; remove: () => void } {
  let repo: ReturnType<typeof scratchRepo> | undefined;
  return {
    path: () => {
      repo ??= scratchRepo();
      return repo.path;
    },
    remove: () => repo?.remove(),
  };
}

// pgrep exits 1 for no match and 2 or more for a real failure, which must not read as "gone".
export function liveProcesses(marker: string): number {
  const res = Bun.spawnSync(["pgrep", "-f", "--", marker]);
  if (res.exitCode === 1) return 0;
  if (res.exitCode !== 0) throw new Error(`pgrep failed: ${res.stderr.toString()}`);
  return res.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "").length;
}
