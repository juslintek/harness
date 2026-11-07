import type { Database } from "bun:sqlite";
import {
  postSlackMessage,
  sendTelegramMessage,
  slackConfigured,
  telegramConfigured,
} from "../notify/api";
import { createEcho, handleInbound } from "./inbound";
import { linkCodesFor } from "./link-codes";
import { type Senders, startOutbound } from "./outbound";
import { linkExternalUser } from "./repo";
import { bridgeRoutes } from "./routes";
import { startSlackSocket } from "./slack";
import { startTelegramPoll } from "./telegram";

export { bridgeRoutes };

export interface BridgeDeps {
  home: string;
  origin: string;
}

function senders(home: string): Senders {
  return {
    slack: async (externalId, text) => {
      const sent = await postSlackMessage(home, externalId, text);
      if (!sent.ok) console.error("bridge: slack post failed:", sent.reason);
    },
    telegram: async (externalId, text) => {
      const sent = await sendTelegramMessage(home, externalId, text);
      if (!sent.ok) console.error("bridge: telegram send failed:", sent.reason);
    },
  };
}

// Socket Mode runs only when both Slack tokens exist and long polling only with a Telegram bot
// token; outbound relaying is cheap, so it is
// always on and each kind's sender decides whether it is configured.
export function startBridges(db: Database, deps: BridgeDeps): () => Promise<void> {
  const echo = createEcho();
  const unsubscribe = startOutbound(db, echo, senders(deps.home));
  const stopSlack = slackConfigured(deps.home)
    ? startSlackSocket({
        home: deps.home,
        onMessage: (msg) => handleInbound(db, echo, msg),
        onLink: (userId, code) => {
          const memberId = linkCodesFor(db).redeem("slack", code);
          return memberId ? linkExternalUser(db, "slack", userId, memberId) : false;
        },
      })
    : null;
  const stopTelegram = telegramConfigured(deps.home)
    ? startTelegramPoll({ db, home: deps.home, echo, codes: linkCodesFor(db) })
    : null;
  return async () => {
    unsubscribe();
    await Promise.all([stopSlack?.(), stopTelegram?.()]);
  };
}
