import type { Database } from "bun:sqlite";
import { postSlackMessage, slackConfigured } from "../notify/api";
import { createEcho, handleInbound } from "./inbound";
import { type Senders, startOutbound } from "./outbound";
import { bridgeRoutes } from "./routes";
import { startSlackSocket } from "./slack";

export { bridgeRoutes };

export interface BridgeDeps {
  home: string;
  origin: string;
}

function slackSenders(home: string): Senders {
  return {
    slack: async (externalId, text) => {
      const sent = await postSlackMessage(home, externalId, text);
      if (!sent.ok) console.error("bridge: slack post failed:", sent.reason);
    },
  };
}

// Socket Mode runs only when both Slack tokens exist; outbound relaying is cheap, so it is
// always on and each kind's sender decides whether it is configured.
export function startBridges(db: Database, deps: BridgeDeps): () => Promise<void> {
  const echo = createEcho();
  const unsubscribe = startOutbound(db, echo, slackSenders(deps.home));
  const stopSlack = slackConfigured(deps.home)
    ? startSlackSocket({ home: deps.home, onMessage: (msg) => handleInbound(db, echo, msg) })
    : null;
  return async () => {
    unsubscribe();
    await stopSlack?.();
  };
}
