import type { Database } from "bun:sqlite";
import { revokeRunTokens } from "../mcp/api";
import { killGroup } from "./acp-rpc";
import { failLiveRuns, listUnendedRuns } from "./runs-repo";

// A recycled pid could belong to anything, so only a process still running through srt is ours.
function isSandboxedAgent(pid: number): boolean {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return ps.exitCode === 0 && ps.stdout.toString().includes("srt");
}

// Live runs, their agent groups and in-process approval waiters do not survive a restart.
export function reapRuns(db: Database): void {
  for (const run of listUnendedRuns(db)) {
    if (run.pid !== null && isSandboxedAgent(run.pid)) killGroup(run.pid, "SIGKILL");
    revokeRunTokens(db, run.id);
  }
  failLiveRuns(db, "harness_restart");
}
