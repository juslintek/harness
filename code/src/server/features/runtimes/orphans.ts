import type { Database } from "bun:sqlite";
import { revokeRunTokens } from "../mcp/api";
import { killGroup } from "./acp-rpc";
import { failLiveRuns, listUnendedRuns } from "./runs-repo";

export interface ProcInfo {
  boot: () => string;
  command: (pid: number) => string | null;
  start: (pid: number) => string | null;
  groupHasMembers: (pgid: number) => boolean;
}

function psField(field: string, pid: number): string | null {
  const ps = Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)]);
  return ps.exitCode === 0 ? ps.stdout.toString().trim() : null;
}

export function bootTime(): string {
  return Bun.spawnSync(["sysctl", "-n", "kern.boottime"]).stdout.toString().trim();
}

const realInfo: ProcInfo = {
  boot: bootTime,
  command: (pid) => psField("command", pid),
  start: (pid) => psField("lstart", pid),
  groupHasMembers: (pgid) => Bun.spawnSync(["pgrep", "-g", String(pgid)]).exitCode === 0,
};

// Stored with the pid so a later start can tell the same process from a recycled pid.
export function pidIdentity(pid: number, info: ProcInfo = realInfo): string | null {
  const start = info.start(pid);
  return start === null ? null : `${info.boot()}|${start}`;
}

// The recorded pid is the group leader (srt), also the group id. After a reboot, or once the pid
// wrapped, it can belong to an unrelated process or group, so the boot time and the leader's start
// time recorded at spawn must still match. A live leader must also still run through srt. A dead
// leader cannot be recycled while its group has members, so within the same boot any member left
// is the agent that outlived srt.
export function ownsGroup(
  pid: number,
  identity: string | null,
  info: ProcInfo = realInfo,
): boolean {
  if (identity === null) return false;
  const sep = identity.indexOf("|");
  if (identity.slice(0, sep) !== info.boot()) return false;
  const command = info.command(pid);
  if (command === null) return info.groupHasMembers(pid);
  return command.includes("srt") && info.start(pid) === identity.slice(sep + 1);
}

// Live runs, their agent groups and in-process approval waiters do not survive a restart.
export function reapRuns(db: Database): void {
  for (const run of listUnendedRuns(db)) {
    if (run.pid !== null && ownsGroup(run.pid, run.identity)) killGroup(run.pid, "SIGKILL");
    revokeRunTokens(db, run.id);
  }
  failLiveRuns(db, "harness_restart");
}
