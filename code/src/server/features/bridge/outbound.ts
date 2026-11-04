import type { Database } from "bun:sqlite";
import { onMessage } from "../chat/api";
import type { Echo } from "./inbound";
import { type BridgeKind, bridgesOfChannel } from "./repo";

// One entry per bridge kind; a kind without an entry is not configured and is skipped.
type Sender = (externalId: string, text: string) => Promise<void>;
export type Senders = Partial<Record<BridgeKind, Sender>>;

export function startOutbound(db: Database, echo: Echo, senders: Senders): () => void {
  return onMessage(({ message, channel }) => {
    // postMessage notifies listeners before it returns the id to the inbound path, so the echo
    // check has to wait one tick or it would never see that id.
    queueMicrotask(() => {
      if (echo.has(message.id)) return;
      const text = `*${message.author?.handle ?? "system"}*: ${message.body}`;
      for (const link of bridgesOfChannel(db, channel.id)) {
        senders[link.kind]?.(link.externalId, text).catch((err) => {
          console.error("bridge: send failed", err instanceof Error ? err.name : "unknown");
        });
      }
    });
  });
}
