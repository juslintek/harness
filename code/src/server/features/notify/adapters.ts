import type { Database } from "bun:sqlite";
import type { Channel } from "../../../shared/notify";
import type { Notifier } from "./port";

// Adapters read their secrets from the secrets file under `home`, so they are built per instance.
export interface AdapterEnv {
  db: Database;
  home: string;
}

function notConfigured(channel: Channel): Notifier {
  return {
    channel,
    deliver: async () => ({ ok: false, retry: false, reason: "not configured" }),
  };
}

// One line per channel: the adapter tasks each replace exactly their own line.
export function buildAdapters(_env: AdapterEnv): Record<Channel, Notifier> {
  return {
    push: notConfigured("push"),
    email: notConfigured("email"),
    slack: notConfigured("slack"),
    telegram: notConfigured("telegram"),
    webhook: notConfigured("webhook"),
  };
}
