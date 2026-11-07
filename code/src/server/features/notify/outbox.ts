import type { Database } from "bun:sqlite";
import type { Channel, DeliverResult, Notification, Target } from "../../../shared/notify";
import { redact } from "../logs/api";
import type { Notifier } from "./port";
import { deleteTarget } from "./targets-repo";

export interface LogRow {
  target: Target;
  n: Notification;
  status: "sent" | "failed" | "dropped";
  reason: string | null;
  attempts: number;
  at: number;
}

// The body is never part of a row; the reason is scrubbed because adapters echo remote errors.
export function writeLog(db: Database, row: LogRow): void {
  db.query(
    `INSERT INTO notify_log (id, target_id, member_id, channel, kind, tag, status, reason, attempts, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Bun.randomUUIDv7(),
    row.target.id,
    row.target.memberId,
    row.target.channel,
    row.n.kind,
    row.n.tag,
    row.status,
    row.reason === null ? null : redact(row.reason).slice(0, 300),
    row.attempts,
    row.at,
  );
}

async function safeDeliver(
  adapter: Notifier,
  target: Target,
  n: Notification,
  base: string,
): Promise<DeliverResult> {
  try {
    return await adapter.deliver(target, n, base);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "delivery threw";
    return { ok: false, retry: false, reason };
  }
}

export interface OutboxDeps {
  db: Database;
  home: string;
  adapters: Record<Channel, Notifier>;
  origin: string | (() => string);
  now: () => number;
  backoffMs: readonly number[];
}

export interface Outbox {
  send(target: Target, n: Notification): void;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

// Delivers with retries; every send ends as exactly one notify_log row.
export function createOutbox(deps: OutboxDeps): Outbox {
  const { db, home, adapters, origin, now, backoffMs } = deps;
  const tasks = new Set<Promise<void>>();
  const sleepers = new Set<() => void>();
  let stopped = false;

  // False when stop() woke the sleep early.
  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve(!stopped);
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });

  async function attemptAll(
    target: Target,
    n: Notification,
  ): Promise<{ result: DeliverResult; attempts: number }> {
    for (let attempts = 1; ; attempts++) {
      const base = typeof origin === "function" ? origin() : origin;
      const result = await safeDeliver(adapters[target.channel], target, n, base);
      const wait = backoffMs[attempts - 1];
      if (result.ok || !result.retry || wait === undefined) return { result, attempts };
      if (stopped) return { result: { ok: false, retry: false, reason: "stopped" }, attempts };
      if (!(await sleep(wait))) {
        return { result: { ok: false, retry: false, reason: "stopped" }, attempts };
      }
    }
  }

  async function deliverTo(target: Target, n: Notification): Promise<void> {
    const { result, attempts } = await attemptAll(target, n);
    if (!result.ok && result.gone) deleteTarget(db, target.memberId, target.id, home);
    const status = result.ok ? "sent" : "failed";
    const reason = result.ok ? null : result.reason;
    writeLog(db, { target, n, status, reason, attempts, at: now() });
  }

  async function idle(): Promise<void> {
    while (tasks.size > 0) await Promise.all([...tasks]);
  }

  return {
    send(target, n) {
      if (stopped) return;
      const task = deliverTo(target, n).finally(() => tasks.delete(task));
      tasks.add(task);
    },
    idle,
    async stop() {
      stopped = true;
      for (const wake of [...sleepers]) wake();
      await idle();
    },
  };
}
