import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { getAccount } from "../agents/api";
import { revokeRunTokens } from "../mcp/api";
import { killGroup } from "./acp-rpc";
import { writeBackAccountAuth } from "./codex-home";
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

// Live runs, their agent groups and in-process approval waiters do not survive a restart. A token
// the run refreshed before the harness died is still only in the run's copy; codex has already
// rotated the account's refresh token, so it is stored the same way a normal end would store it.
export async function reapRuns(db: Database, home: string): Promise<void> {
  const runs = listUnendedRuns(db);
  for (const run of runs) {
    if (run.pid !== null && ownsGroup(run.pid, run.identity)) killGroup(run.pid, "SIGKILL");
    revokeRunTokens(db, run.id);
  }
  failLiveRuns(db, "harness_restart");
  for (const run of runs) {
    const accountHome = run.accountId === null ? null : getAccount(db, run.accountId)?.home;
    if (accountHome == null) continue;
    await writeBackAccountAuth(join(home, "runs", run.id), accountHome).catch((err: unknown) =>
      console.error("account write-back failed", err),
    );
  }
}
