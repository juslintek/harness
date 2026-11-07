import type { Database } from "bun:sqlite";
import type { WakeReason, WakeupView } from "../../../shared/heartbeat";
import { getTask, onTaskChange } from "../board/api";
import { channelAccess, getChannel, onMessage } from "../chat/api";
import { onApprovalChange, startApprovalExpiry } from "../guard/api";
import { triageWake } from "../laya/api";
import { appendEvent } from "../logs/api";
import { startRetro } from "../memory/api";
import { projectAccess } from "../orgs/api";
import { onProposalChange } from "../policies/api";
import { isHalted, onRunEvent, type RunDeps } from "../runtimes/api";
import { onApprovalResolved } from "./approval-wakes";
import { runPending, sweepEnded } from "./executor";
import { onPolicyChange } from "./policy-wakes";
import { endedStartedRuns, failStartedWakes, listWakeups as list } from "./repo";
import type { ExecDeps } from "./run-input";
import { dueSchedules, onChat, onTask, recordWake, runNow } from "./triggers";

export interface HeartbeatDeps extends ExecDeps {
  runDeps: RunDeps;
  tickMs?: number;
  triage?: typeof triageWake;
}

const DEFAULT_TICK_MS = 60_000;
const kickers = new Set<() => void>();

type Report = (what: string, err: unknown) => void;

function listenForWakes(
  db: Database,
  triage: typeof triageWake,
  kick: () => void,
  report: Report,
): Array<() => void> {
  return [
    onTaskChange((change) => {
      onTask(db, change);
      kick();
    }),
    onMessage((event) => {
      onChat(db, event, triage).then(kick, (err: unknown) => report("message trigger", err));
    }),
    onRunEvent((_runId, event) => {
      if (event.kind === "run") kick();
    }),
    onProposalChange((change) => {
      try {
        if (onPolicyChange(db, change)) kick();
      } catch (err) {
        report("policy trigger", err);
      }
    }),
    onApprovalChange((approval) => {
      try {
        if (onApprovalResolved(db, approval)) kick();
      } catch (err) {
        report("approval trigger", err);
      }
    }),
  ];
}

// The returned stop ends the loop at once and resolves when the launch or settle it was in the
// middle of has finished, so a caller can close the db behind it.
export function startHeartbeat(db: Database, deps: HeartbeatDeps): () => Promise<void> {
  const report: Report = (what, err) => {
    console.error(`heartbeat ${what} failed`, err);
    appendEvent(db, { kind: "error", source: "heartbeat", body: `${what} failed: ${String(err)}` });
  };
  failStartedWakes(db);
  // Serialised so two triggers in a row cannot start two runs for one member.
  let chain: Promise<void> = Promise.resolve();
  let deferred = false;
  let stopped = false;
  // Settling runs here, ahead of the next launch, so a member whose run just ended cannot start a
  // second run while a failover is still starting its replacement.
  const kick = (): void => {
    if (stopped) return;
    chain = chain
      .then(async () => {
        if (stopped) return;
        await sweepEnded(db, deps);
        deferred = await runPending(db, deps);
      })
      .catch((err: unknown) => report("executor", err));
  };
  kickers.add(kick);
  const offs = listenForWakes(db, deps.triage ?? triageWake, kick, report);
  offs.push(
    startApprovalExpiry(db),
    startRetro(db, {
      enqueueWake: (memberId, reason, detail, taskId) => {
        recordWake(db, { memberId, reason, detail, taskId: taskId ?? undefined, causedBy: null });
        kick();
      },
    }),
  );
  const timer = setInterval(() => {
    try {
      const swept = endedStartedRuns(db).length > 0;
      const scheduled = isHalted(db) ? 0 : dueSchedules(db, Date.now());
      if (swept || scheduled > 0 || deferred) kick();
    } catch (err) {
      report("schedule tick", err);
    }
  }, deps.tickMs ?? DEFAULT_TICK_MS);
  timer.unref();
  kick();
  return () => {
    stopped = true;
    clearInterval(timer);
    kickers.delete(kick);
    for (const off of offs) off();
    return chain;
  };
}

export function wakeNow(db: Database, memberId: string, causedBy: string, taskId?: string): string {
  const id = runNow(db, memberId, causedBy, taskId);
  for (const kick of kickers) kick();
  return id;
}

// For wakes that belong to no task or channel, like the hiring ones. Quietly nothing for a human,
// a paused agent or one over its hourly cap, same as every other trigger.
export function wakeFor(
  db: Database,
  memberId: string,
  reason: WakeReason,
  detail: object,
  causedBy: string,
): void {
  recordWake(db, { memberId, reason, detail, causedBy });
  for (const kick of kickers) kick();
}

function visibleChannel(db: Database, w: WakeupView, viewerId: string): WakeupView {
  const channel = w.channelId === null ? null : getChannel(db, w.channelId);
  if (!channel || channelAccess(db, viewerId, channel.id) === "none") {
    return { ...w, channelId: null, channelName: null, messageId: null };
  }
  return { ...w, channelName: channel.name };
}

function visibleTask(db: Database, w: WakeupView, viewerId: string): WakeupView {
  const task = w.taskId === null ? null : getTask(db, w.taskId);
  if (!task || projectAccess(db, { memberId: viewerId }, task.projectId) === "none") {
    return { ...w, taskId: null, taskNumber: null };
  }
  return { ...w, taskNumber: task.number };
}

// The list is for any org member, so it carries no message or comment text, and a channel or task
// only shows for a viewer who may open it (a DM must not leak through its wake).
export function listWakeups(
  db: Database,
  orgId: string,
  limit: number,
  viewerId: string,
): WakeupView[] {
  return list(db, orgId, limit).map((w) => {
    const { excerpt: _text, ...detail } = (w.detail ?? {}) as Record<string, unknown>;
    if (w.reason === "approval_resolved" && detail.kind === "command") delete detail.reason;
    return visibleTask(db, visibleChannel(db, { ...w, detail }, viewerId), viewerId);
  });
}
