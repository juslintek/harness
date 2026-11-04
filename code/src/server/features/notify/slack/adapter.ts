import type { Notifier } from "../port";
import { postSlackMessage } from "./client";

export function slackNotifier(home: string): Notifier {
  return {
    channel: "slack",
    deliver: (target, n, base) =>
      postSlackMessage(
        home,
        target.value.userId ?? "",
        `*${n.title}*\n${n.body}\n${base}${n.path}`,
      ),
  };
}
