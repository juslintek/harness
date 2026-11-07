import type { Notifier } from "../port";
import { sendTelegramMessage } from "./client";

export function telegramNotifier(home: string): Notifier {
  return {
    channel: "telegram",
    deliver: (target, n, base) =>
      sendTelegramMessage(
        home,
        target.value.chatId ?? "",
        `${n.title}\n${n.body}\n${base}${n.path}`,
      ),
  };
}
