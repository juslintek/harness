import type { Database } from "bun:sqlite";
import { revokeRunTokens } from "../mcp/api";
import { killGroup } from "./acp-rpc";
import { failLiveRuns, listUnendedRuns } from "./runs-repo";

// The recorded pid is the group leader (srt), also the group id. A live leader could be a recycled
// pid, so it only counts while it is still running through srt. A dead leader cannot be recycled
// while its group has members (the kernel keeps the id reserved), so any member left is the agent
// that outlived srt.
export function ownsGroup(pid: number): boolean {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  if (ps.exitCode === 0) return ps.stdout.toString().includes("srt");
  return Bun.spawnSync(["pgrep", "-g", String(pid)]).exitCode === 0;
}

// Live runs, their agent groups and in-process approval waiters do not survive a restart.
export function reapRuns(db: Database): void {
  for (const run of listUnendedRuns(db)) {
    if (run.pid !== null && ownsGroup(run.pid)) killGroup(run.pid, "SIGKILL");
    revokeRunTokens(db, run.id);
  }
  failLiveRuns(db, "harness_restart");
}
