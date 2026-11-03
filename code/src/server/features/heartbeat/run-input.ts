import type { Database } from "bun:sqlite";
import { getTask } from "../board/api";
import { getChannel } from "../chat/api";
import { appendEvent } from "../logs/api";
import type { TokenScope } from "../mcp/api";
import { directReportsOf, type MemberRow, managerPositionsOf } from "../orgs/api";
import type { RouteDeps } from "../router/api";
import type { RunDeps, RunMember } from "../runtimes/api";
import { setStatus, type WakeRow } from "./repo";

export interface ExecDeps {
  runDeps: RunDeps;
  home: string;
  // Tests inject a fixed agent list; real discovery spawns every installed CLI.
  routeDeps?: RouteDeps;
}

export function wakeProject(db: Database, wake: WakeRow): string | null {
  const task = wake.taskId === null ? null : getTask(db, wake.taskId);
  const channel = wake.channelId === null ? null : getChannel(db, wake.channelId);
  return task?.projectId ?? channel?.projectId ?? null;
}

function scopesFor(db: Database, member: MemberRow): TokenScope[] {
  const scopes: TokenScope[] = [
    "report",
    "guard_hook",
    "board",
    "chat",
    "hiring",
    "profile",
    "policy",
  ];
  if (managerPositionsOf(db, member.id).length > 0) scopes.push("approvals_decide");
  return scopes;
}

export function runMember(db: Database, member: MemberRow, projectId: string | null): RunMember {
  return {
    memberId: member.id,
    orgId: member.orgId,
    scopes: scopesFor(db, member),
    ...(directReportsOf(db, member.id).length > 0 ? { readOnly: true } : {}),
    ...(projectId === null ? {} : { projectId }),
  };
}

export function fail(db: Database, ids: string[], err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(db, ids, "failed", { detail: { error: message } });
  appendEvent(db, { kind: "error", source: "heartbeat", body: `wake run failed: ${message}` });
}
