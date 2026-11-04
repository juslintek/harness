import type { Channel } from "../../../shared/notify";
import type { Notifier } from "./port";

function notConfigured(channel: Channel): Notifier {
  return {
    channel,
    deliver: async () => ({ ok: false, retry: false, reason: "not configured" }),
  };
}

// One line per channel: the adapter tasks each replace exactly their own line.
export const ADAPTERS: Record<Channel, Notifier> = {
  push: notConfigured("push"),
  email: notConfigured("email"),
  slack: notConfigured("slack"),
  telegram: notConfigured("telegram"),
  webhook: notConfigured("webhook"),
};
