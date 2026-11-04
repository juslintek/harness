import type { Channel, DeliverResult, Notification, Target } from "../../../shared/notify";

// `base` is the public origin, used to build absolute links in the message.
export interface Notifier {
  readonly channel: Channel;
  deliver(target: Target, n: Notification, base: string): Promise<DeliverResult>;
}

export function createNotifiers(): readonly Notifier[] {
  return [];
}
