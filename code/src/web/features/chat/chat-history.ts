import { useEffect, useState } from "preact/hooks";
import { type MessageView, messageListSchema } from "../../../shared/chat";
import { api } from "../../api";

export const PAGE_SIZE = 50;

interface Seen {
  key: string;
  items: MessageView[];
  exhausted: boolean;
}

function merge(a: MessageView[], b: MessageView[]): MessageView[] {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
}

export interface History {
  messages: MessageView[];
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
}

// The latest page is refetched on every chat event, so what was shown before is kept here:
// older pages the user asked for must stay, and so must messages a busy channel pushed out of
// the latest window. With a thread root the history is that thread's replies instead.
export function useHistory(
  channelId: string | null,
  latest: MessageView[] | null,
  threadRootId: string | null = null,
): History {
  const [seen, setSeen] = useState<Seen | null>(null);
  const key = threadRootId ?? channelId;
  const current =
    latest?.filter((m) => m.channelId === channelId && m.threadRootId === threadRootId) ?? [];
  const mine = seen !== null && seen.key === key ? seen : null;
  useEffect(() => {
    if (key === null || current.length === 0) return;
    setSeen((s) =>
      s?.key === key
        ? { ...s, items: merge(s.items, current) }
        : { key, items: current, exhausted: current.length < PAGE_SIZE },
    );
  }, [key, latest]);
  const messages = merge(mine?.items ?? [], current);
  const oldest = messages[0];
  const loadOlder = async (): Promise<void> => {
    if (channelId === null || !oldest) return;
    const cursor = `${oldest.createdAt}:${oldest.id}`;
    const thread = threadRootId === null ? "" : `&thread=${threadRootId}`;
    const page = await api(
      `/api/channels/${channelId}/messages?before=${cursor}&limit=${PAGE_SIZE}${thread}`,
      messageListSchema,
    );
    setSeen((s) =>
      s?.key === key
        ? { ...s, items: merge(s.items, page), exhausted: page.length < PAGE_SIZE }
        : s,
    );
  };
  return {
    messages,
    hasOlder: mine === null ? current.length >= PAGE_SIZE : !mine.exhausted,
    loadOlder,
  };
}
