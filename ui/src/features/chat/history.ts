import type { MessageView } from "@shared/chat";
import { createEffect, createMemo, createSignal } from "solid-js";

export const PAGE_SIZE = 50;

export function merge(a: MessageView[], b: MessageView[]): MessageView[] {
  const byId = new Map([...a, ...b].map((m) => [m.id, m]));
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
}

export interface History {
  messages: () => MessageView[];
  hasOlder: () => boolean;
  loadOlder: () => Promise<void>;
}

// The latest page is refetched on every chat event, so what was shown before is kept here: older
// pages the person asked for must stay, and so must messages a busy channel pushed out of the
// latest window. Make one per channel or thread; it never resets.
export function createHistory(
  latest: () => MessageView[] | undefined,
  fetchOlder: (cursor: string) => Promise<MessageView[]>,
): History {
  const [seen, setSeen] = createSignal<MessageView[]>([]);
  const [exhausted, setExhausted] = createSignal<boolean | null>(null);
  createEffect(() => {
    const page = latest();
    if (!page || page.length === 0) return;
    setSeen((s) => merge(s, page));
    setExhausted((e) => e ?? page.length < PAGE_SIZE);
  });
  const messages = createMemo(() => merge(seen(), latest() ?? []));
  const loadOlder = async (): Promise<void> => {
    const oldest = messages()[0];
    if (!oldest) return;
    const page = await fetchOlder(`${oldest.createdAt}:${oldest.id}`);
    setSeen((s) => merge(s, page));
    setExhausted(page.length < PAGE_SIZE);
  };
  return { messages, hasOlder: () => exhausted() === false, loadOlder };
}
