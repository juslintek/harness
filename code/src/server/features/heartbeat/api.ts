import type { Database } from "bun:sqlite";
import type { WakeupView } from "../../../shared/heartbeat";
import { onTaskChange } from "../board/api";
import { onMessage } from "../chat/api";
import { triageWake } from "../laya/api";
import { appendEvent } from "../logs/api";
import { onRunEvent, type RunDeps } from "../runtimes/api";
import { type ExecDeps, runPending, settleRun } from "./executor";
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
      settleRun(db, runId);
      kick();
    }),
  ];
  const timer = setInterval(() => {
    try {
      if (dueSchedules(db, Date.now()) > 0 || deferred) kick();
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

export function listWakeups(db: Database, orgId: string, limit: number): WakeupView[] {
  return list(db, orgId, limit);
}
