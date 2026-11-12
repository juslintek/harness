import { createEffect, createSignal } from "solid-js";
import type { z } from "zod";
import { api } from "./api";
import { errorText } from "./format";
import { createTopic, type WsFrame } from "./realtime";

export interface Load<T> {
  data: () => T | undefined;
  error: () => string | null;
  loading: () => boolean;
  reload: () => Promise<void>;
}

// Fetches through api() and refetches when a topic says something changed. A refetch keeps the old
// data on screen, and an answer that arrives after a newer request was sent is dropped.
export function createLoad<T>(
  path: string | (() => string),
  schema: z.ZodType<T>,
  topics: string[] = [],
  // Which messages count as a change; the default is every one on the topic.
  accept: (frame: WsFrame) => boolean = () => true,
): Load<T> {
  const url = typeof path === "string" ? () => path : path;
  const [data, setData] = createSignal<T>();
  const [error, setError] = createSignal<string | null>(null);
  let latest = 0;
  const reload = async (): Promise<void> => {
    const mine = ++latest;
    try {
      const next = await api(url(), schema);
      if (mine !== latest) return;
      setData(() => next);
      setError(null);
    } catch (err) {
      if (mine === latest) setError(errorText(err));
    }
  };
  // url() is read synchronously inside reload, so a changing path reruns this effect.
  createEffect(() => void reload());
  for (const topic of topics) {
    // The socket's first open only repeats the fetch above; later opens catch what was missed.
    let opened = false;
    createTopic(topic, (frame) => {
      if (frame === null) {
        if (opened) void reload();
        opened = true;
      } else if (accept(frame)) void reload();
    });
  }
  return { data, error, loading: () => data() === undefined && error() === null, reload };
}
