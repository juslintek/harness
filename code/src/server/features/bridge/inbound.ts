import type { Database } from "bun:sqlite";
import { ChatError, postMessage } from "../chat/api";
import { type BridgeKind, bridgeByExternal, memberOfExternal } from "./repo";

const MAX_TRACKED = 1000;
const MAX_BODY = 8000;

export interface InboundMessage {
  kind: BridgeKind;
  externalChannel: string;
  externalUser: string;
  text: string;
}

// Ids of messages the inbound path created, so the outbound path does not send them back out.
export interface Echo {
  mark(messageId: string): void;
  has(messageId: string): boolean;
}

export function createEcho(): Echo {
  const ids = new Set<string>();
  return {
    mark(messageId) {
      ids.add(messageId);
      // A Set iterates in insertion order, so the first value is the oldest.
      if (ids.size > MAX_TRACKED) ids.delete(ids.values().next().value as string);
    },
    has: (messageId) => ids.has(messageId),
  };
}

// Unlinked chats and unlinked people are dropped without a trace: nothing about them is stored.
export function handleInbound(db: Database, echo: Echo, msg: InboundMessage): void {
  const link = bridgeByExternal(db, msg.kind, msg.externalChannel);
  const authorId = memberOfExternal(db, msg.kind, msg.externalUser);
  const body = msg.text.trim().slice(0, MAX_BODY);
  if (!link || !authorId || !body) return;
  try {
    echo.mark(postMessage(db, { channelId: link.channelId, authorId, body }).id);
  } catch (err) {
    // The member may have lost access since linking; that must not break the socket loop.
    if (!(err instanceof ChatError)) throw err;
  }
}
