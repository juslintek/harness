import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveShareDir } from "../../packaged";
import { appendLog, getRequest, setFlagged, setStatus, type UpdateRequest } from "./requests";
import { verifyOnScratch } from "./scratch";
import { snapshotDb } from "./snapshot";
import {
  addWorktree,
  assertCleanTree,
  classifyChange,
  expectedVersion,
  headSha,
  removeWorktree,
  runBuild,
  runCheck,
  type StepDeps,
} from "./steps";
import { flipSymlink } from "./swap";

export interface PipelineDeps {
  home: string;
  port: number;
  // The live process, which the swap helper waits on.
  pid: number;
  // The binary the live process runs; it is the rollback target the first time.
  liveBinary: string;
  // The commit the live binary was built from; null when unknown (every update then needs approval).
  runningCommit: string | null;
  steps: StepDeps;
  beginShutdown: () => void;
  verifyMs: number;
}

function isMissingOrSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

// A self-update moves the running binary into <home>/bin/harness-<id>; preserve the original
// installation's packaged assets (ui/, adapters/, vendor/) at <home>/share/harness and in the
// swap environment so both the immediate restart and future service restarts find them.
export function preserveShareDir(
  home: string,
  liveBinary: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const share = resolveShareDir(env, { execPath: liveBinary });
  if (!share) return undefined;
  let shareReal = resolve(share);
  try {
    shareReal = realpathSync(share);
  } catch {
    // Keep lexical path if realpath fails.
  }
  const link = join(home, "share", "harness");
  if (resolve(link) !== shareReal && isMissingOrSymlink(link)) {
    flipSymlink(link, shareReal);
  }
  return shareReal;
}

function spawnSwap(
  binary: string,
  args: string[],
  log: string,
  shareDir: string | undefined,
): void {
  const env = shareDir ? { ...process.env, HARNESS_SHARE_DIR: shareDir } : process.env;
  const proc = Bun.spawn([binary, "swap", ...args], {
    env,
    stdin: "ignore",
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    detached: true,
  });
  proc.unref();
}

async function startSwap(
  db: Database,
  req: UpdateRequest,
  deps: PipelineDeps,
  binary: string,
): Promise<void> {
  setStatus(db, req.id, "swapping");
  // Taken after the status flip so a rollback restores a row that says `swapping`, and as late
  // as possible so little live data written since is lost by a restore.
  const snapshot = snapshotDb(db, deps.home, `${req.id}-swap`);
  const current = join(deps.home, "bin", "current");
  const previous = existsSync(current) ? realpathSync(current) : deps.liveBinary;
  const shareDir = preserveShareDir(deps.home, deps.liveBinary);
  flipSymlink(current, binary);
  spawnSwap(
    current,
    [
      "--old-pid",
      `${deps.pid}`,
      "--current",
      current,
      "--previous",
      previous,
      "--home",
      deps.home,
      "--port",
      `${deps.port}`,
      "--snapshot",
      snapshot,
      "--request",
      req.id,
    ],
    join(deps.home, `selfupdate-${req.id}.log`),
    shareDir,
  );
  deps.beginShutdown();
}

// Defence in depth right before the swap: what is about to run must be the pinned commit, and
// the diff classified now (the default branch may have moved) must not need a decision nobody made.
async function assertStillPinned(
  db: Database,
  req: UpdateRequest,
  tree: string,
  deps: PipelineDeps,
): Promise<void> {
  const now = getRequest(db, req.id);
  if (!now || now.commitSha !== req.commitSha || (await headSha(tree)) !== req.commitSha) {
    throw new Error("pinned commit changed during the pipeline");
  }
  const flagged = await classifyChange(req.repo, now.commitSha, deps.runningCommit);
  if (flagged.length > 0 && now.decidedBy === null) {
    throw new Error("guard paths changed without approval");
  }
}

async function execute(
  db: Database,
  req: UpdateRequest,
  deps: PipelineDeps,
  tree: string,
): Promise<void> {
  setStatus(db, req.id, "checking");
  const flagged = await classifyChange(req.repo, req.commitSha, deps.runningCommit);
  if (flagged.length > 0 && req.decidedBy === null) {
    setFlagged(db, req.id, flagged);
    setStatus(db, req.id, "awaiting_approval");
    return;
  }
  await addWorktree(req.repo, tree, req.commitSha);
  const codeDir = join(tree, "code");
  appendLog(db, req.id, await runCheck(deps.steps, codeDir));
  await assertCleanTree(tree);
  setStatus(db, req.id, "building");
  const binary = await runBuild(
    deps.steps,
    codeDir,
    join(tree, "dist"),
    join(deps.home, "bin", `harness-${req.id}`),
  );
  setStatus(db, req.id, "verifying");
  await verifyOnScratch({
    binary,
    snapshot: snapshotDb(db, deps.home, req.id),
    scratchHome: join(deps.home, "selfupdate", `${req.id}-scratch`),
    version: expectedVersion(deps.steps, codeDir),
    timeoutMs: deps.verifyMs,
  });
  await assertStillPinned(db, req, tree, deps);
  await startSwap(db, req, deps, binary);
}

// Every failure before the swap leaves the live process and its data untouched.
export async function runPipeline(db: Database, id: string, deps: PipelineDeps): Promise<void> {
  const req = getRequest(db, id);
  if (!req) return;
  const tree = join(deps.home, "selfupdate", id);
  try {
    await execute(db, req, deps, tree);
  } catch (err) {
    appendLog(db, id, (err as Error).message);
    setStatus(db, id, "failed", (err as Error).message.slice(0, 500));
  } finally {
    await removeWorktree(req.repo, tree);
  }
}
