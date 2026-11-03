import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../git-env";

function git(args: string[], cwd: string): void {
  const res = Bun.spawnSync(
    ["git", "-c", "user.name=harness", "-c", "user.email=harness@localhost", ...args],
    { cwd, env: gitEnv() },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

// A worktree needs a commit to branch from, so the shared scratch repo starts with an empty one.
export function scratchRepo(home: string, orgId: string): string {
  const dir = join(home, "scratch", orgId);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
  }
  return dir;
}
