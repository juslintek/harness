import type { Database } from "bun:sqlite";
import { CHANNELS, type Channel, type Notification, type Target } from "../../../shared/notify";
import { redact } from "../logs/api";
import { buildAdapters } from "./adapters";
import { createOutbox, writeLog } from "./outbox";
import type { Notifier } from "./port";
import { isEnabled } from "./prefs";
import { targetsOf } from "./targets-repo";

const BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];
const WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 30;

export interface DispatcherDeps {
  home: string;
  origin: string;
  adapters?: Partial<Record<Channel, Notifier>>;
  now?: () => number;
  backoffMs?: readonly number[];
}

export interface Dispatcher {
  notify(memberIds: string[], n: Notification): void;
  // Resolves when every started delivery, including pending retries, has finished.
  idle(): Promise<void>;
  // Wakes pending retries so they end as failed, then waits for the running deliveries.
  stop(): Promise<void>;
}

type Verdict = "ok" | "duplicate" | "rate";

// In memory on purpose: it must be race free for sends that are still in flight, and a restart
// only forgets a minute of history.
function createLimiter(now: () => number): (target: Target, tag: string) => Verdict {
  const seen = new Map<string, number>();
  const sends = new Map<string, number[]>();
  return (target, tag) => {
    const t = now();
    for (const [key, at] of seen) if (t - at >= WINDOW_MS) seen.delete(key);
    const key = `${tag}\0${target.id}`;
    if (seen.has(key)) return "duplicate";
    const recent = (sends.get(target.memberId) ?? []).filter((at) => t - at < WINDOW_MS);
    sends.set(target.memberId, recent);
    if (recent.length >= MAX_SENDS_PER_WINDOW) return "rate";
    seen.set(key, t);
    recent.push(t);
    return "ok";
  };
}

export function createDispatcher(db: Database, deps: DispatcherDeps): Dispatcher {
  const now = deps.now ?? Date.now;
  const outbox = createOutbox({
    db,
    home: deps.home,
    adapters: { ...buildAdapters({ db, home: deps.home }), ...deps.adapters },
    origin: deps.origin,
    now,
    backoffMs: deps.backoffMs ?? BACKOFF_MS,
  });
  const admit = createLimiter(now);
  let stopped = false;

  function route(target: Target, n: Notification): void {
    const verdict = admit(target, n.tag);
    if (verdict === "ok") {
      outbox.send(target, n);
      return;
    }
    const reason = verdict === "duplicate" ? "duplicate tag" : "rate cap";
    writeLog(db, { target, n, status: "dropped", reason, attempts: 0, at: now() });
  }

  function fanOut(memberId: string, n: Notification): void {
    for (const channel of CHANNELS) {
      if (!isEnabled(db, memberId, channel, n.kind)) continue;
      for (const target of targetsOf(db, memberId, channel)) route(target, n);
    }
  }

  return {
    notify(memberIds, n) {
      if (stopped) return;
      const clean = { ...n, title: redact(n.title), body: redact(n.body) };
      for (const memberId of new Set(memberIds)) {
        try {
          fanOut(memberId, clean);
        } catch (err) {
          console.error("notify: dispatch failed", err instanceof Error ? err.message : "unknown");
        }
      }
    },
    idle: outbox.idle,
    async stop() {
      stopped = true;
      await outbox.stop();
    },
  };
}
