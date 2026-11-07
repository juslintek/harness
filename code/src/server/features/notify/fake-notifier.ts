import type { Channel, DeliverResult, Notification, Target } from "../../../shared/notify";
import type { Notifier } from "./port";

export interface FakeNotifier extends Notifier {
  calls: { target: Target; n: Notification; base: string }[];
}

// Answers from `script` in order, then ok.
export function fakeNotifier(channel: Channel, script: DeliverResult[] = []): FakeNotifier {
  const calls: FakeNotifier["calls"] = [];
  return {
    channel,
    calls,
    deliver: async (target, n, base) => {
      calls.push({ target, n, base });
      return script.shift() ?? { ok: true };
    },
  };
}
