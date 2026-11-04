import type { Database } from "bun:sqlite";
import type { Channel, Notification, TargetView } from "../../../shared/notify";
import { createDispatcher, type Dispatcher, type DispatcherDeps } from "./dispatcher";
import { emailCodeSender } from "./email/adapter";
import { subscribeEvents } from "./events";
import { effectivePrefs, setPref } from "./prefs";
import { notifyRoutes } from "./routes";
import { openSlackConnection, postSlackMessage, slackConfigured } from "./slack/client";
import { deleteTarget, insertTarget, targetsOf, viewOf } from "./targets-repo";
import {
  getTelegramUpdates,
  sendTelegramMessage,
  type TelegramUpdate,
  telegramConfigured,
} from "./telegram/client";

export type { TelegramUpdate };
export {
  effectivePrefs,
  emailCodeSender,
  getTelegramUpdates,
  notifyRoutes,
  openSlackConnection,
  postSlackMessage,
  sendTelegramMessage,
  setPref,
  slackConfigured,
  telegramConfigured,
};

export interface NotifyDeps extends Partial<Omit<DispatcherDeps, "origin" | "home">> {
  home: string;
  origin: string;
}

// Keyed by db so a second app (tests, gates) never reaches another one's adapters.
const active = new WeakMap<Database, Dispatcher>();

export function startNotify(db: Database, deps: NotifyDeps): () => Promise<void> {
  const dispatcher = createDispatcher(db, deps);
  active.set(db, dispatcher);
  const unsubscribe = subscribeEvents(db, dispatcher.notify);
  return async () => {
    unsubscribe();
    active.delete(db);
    await dispatcher.stop();
  };
}

// Fire and forget: a notification problem must never fail the event that caused it.
export function notifyMembers(db: Database, memberIds: string[], n: Notification): void {
  try {
    active.get(db)?.notify(memberIds, n);
  } catch (err) {
    console.error("notify: failed", err instanceof Error ? err.message : "unknown");
  }
}

export function addTarget(
  db: Database,
  memberId: string,
  channel: Channel,
  value: Record<string, string>,
): string {
  return insertTarget(db, memberId, channel, value);
}

export function listTargets(db: Database, memberId: string): TargetView[] {
  return targetsOf(db, memberId).map(viewOf);
}

export function removeTarget(db: Database, memberId: string, targetId: string): boolean {
  return deleteTarget(db, memberId, targetId);
}
