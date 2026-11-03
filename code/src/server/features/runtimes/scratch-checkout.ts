import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitOk, RUN_ID, removeWorktree } from "./worktree";

// Keyed by run id so the finalize path can clean up without knowing the harness home.
const open = new Map<string, string>();

// A manager's own worktree is read-only, so it runs tests in a detached checkout of HEAD instead.
export async function createScratchCheckout(
  repo: string,
  runId: string,
  home: string,
): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const parent = join(home, "scratch-checkouts");
  await mkdir(parent, { recursive: true });
  const path = join(await realpath(parent), runId);
  await gitOk(["worktree", "add", "--detach", path, "HEAD"], repo);
  open.set(runId, path);
  return path;
}

export async function dropScratchCheckout(runId: string): Promise<void> {
  const path = open.get(runId);
  if (path === undefined) return;
  open.delete(runId);
  try {
    await removeWorktree(path);
  } catch (err) {
    console.error(`scratch checkout of run ${runId} not removed`, err);
  }
}

// A linked worktree's `.git` file reads `gitdir: <common>/worktrees/<name>`.
async function commonDirOf(path: string): Promise<string | null> {
  try {
    const pointer = (await Bun.file(join(path, ".git")).text()).trim();
    return pointer.startsWith("gitdir: ") ? dirname(dirname(pointer.slice(8))) : null;
  } catch {
    return null;
  }
}

// A crash or restart loses the in-memory map, so checkouts of runs that are no longer live would
// stay forever. Only direct children named like a run id are touched.
export async function sweepScratchCheckouts(home: string): Promise<void> {
  const parent = join(home, "scratch-checkouts");
  const names = await readdir(parent).catch(() => [] as string[]);
  for (const name of names) {
    if (!RUN_ID.test(name) || open.has(name)) continue;
    const path = join(parent, name);
    const common = await commonDirOf(path);
    try {
      if (common !== null)
        await gitOk(["--git-dir", common, "worktree", "remove", "--force", path], common);
    } catch (err) {
      console.error(`stale scratch checkout ${path} not removed by git`, err);
    }
    await rm(path, { recursive: true, force: true });
    if (common !== null)
      await gitOk(["--git-dir", common, "worktree", "prune"], common).catch(() => "");
  }
}
