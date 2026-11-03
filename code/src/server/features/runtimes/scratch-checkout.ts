import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { gitOk, removeWorktree } from "./worktree";

// Keyed by run id so the finalize path can clean up without knowing the harness home.
const open = new Map<string, string>();

// A manager's own worktree is read-only, so it runs tests in a detached checkout of HEAD instead.
export async function createScratchCheckout(
  repo: string,
  runId: string,
  home: string,
): Promise<string> {
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
