import type { Database } from "bun:sqlite";
import type { WakeupView } from "../../../shared/heartbeat";
import { getTask, onTaskChange } from "../board/api";
import { channelAccess, getChannel, onMessage } from "../chat/api";
import { triageWake } from "../laya/api";
import { appendEvent } from "../logs/api";
import { projectAccess } from "../orgs/api";
import { isHalted, onRunEvent, type RunDeps } from "../runtimes/api";
import { type ExecDeps, runPending, settleRun, sweepEnded } from "./executor";
import { failStartedWakes, listWakeups as list } from "./repo";
import { dueSchedules, onChat, onTask, runNow } from "./triggers";

export interface HeartbeatDeps extends ExecDeps {
  runDeps: RunDeps;
  tickMs?: number;
  triage?: typeof triageWake;
}

const DEFAULT_TICK_MS = 60_000;
const kickers = new Set<() => void>();

export function startHeartbeat(db: Database, deps: HeartbeatDeps): () => void {
  const triage = deps.triage ?? triageWake;
  const report = (what: string, err: unknown): void => {
    console.error(`heartbeat ${what} failed`, err);
    appendEvent(db, { kind: "error", source: "heartbeat", body: `${what} failed: ${String(err)}` });
  };
  failStartedWakes(db);
  // Serialised so two triggers in a row cannot start two runs for one member.
  let chain: Promise<void> = Promise.resolve();
  let deferred = false;
  const kick = (): void => {
    chain = chain
      .then(async () => {
        deferred = await runPending(db, deps);
      })
      .catch((err: unknown) => report("executor", err));
  };
  kickers.add(kick);
  const offs = [
    onTaskChange((change) => {
      onTask(db, change);
      kick();
    }),
    onMessage((event) => {
      onChat(db, event, triage).then(kick, (err: unknown) => report("message trigger", err));
    }),
    onRunEvent((runId, event) => {
      if (event.kind !== "run") return;
      try {
        settleRun(db, runId);
      } catch (err) {
        report("run end", err);
      }
      kick();
    }),
  ];
  const timer = setInterval(() => {
    try {
      const swept = sweepEnded(db);
      const scheduled = isHalted(db) ? 0 : dueSchedules(db, Date.now());
      if (swept || scheduled > 0 || deferred) kick();
    } catch (err) {
      report("schedule tick", err);
    }
  }, deps.tickMs ?? DEFAULT_TICK_MS);
  timer.unref();
  kick();
  return () => {
    clearInterval(timer);
    kickers.delete(kick);
    for (const off of offs) off();
  };
}

export function wakeNow(db: Database, memberId: string, causedBy: string): string {
  const id = runNow(db, memberId, causedBy);
  for (const kick of kickers) kick();
  return id;
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
    return visibleTask(db, visibleChannel(db, { ...w, detail }, viewerId), viewerId);
  });
}
