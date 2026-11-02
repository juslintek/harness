import { type Signal, signal } from "@preact/signals";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { z } from "zod";
import { type WsMessage, wsMessageSchema } from "../shared/runs";

// Set when any call gets a 401, so the shell can tell the user how to log in instead of showing broken pages.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export const loggedOut: Signal<boolean> = signal(false);

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method: "POST"; body: unknown },
): Promise<T> {
  const res = await fetch(path, {
    ...(init
      ? {
          method: init.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(init.body),
        }
      : {}),
    credentials: "same-origin",
  });
  if (res.status === 401) loggedOut.value = true;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
    throw new ApiError(res.status, message || `HTTP ${res.status}`);
  }
  return schema.parse(body);
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null }),
      (err: unknown) => live && setState((s) => ({ ...s, error: String(err) })),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

// Messages only say "something changed"; callers refetch. The handler also runs with null on every
// socket open, so whatever happened while the socket was down (or before it first connected) is picked up.
export function useTopic(topic: string, onMessage: (m: WsMessage | null) => void): void {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let delay = RECONNECT_MIN_MS;
    const connect = (): void => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws?topic=${encodeURIComponent(topic)}`);
      socket.onopen = () => {
        delay = RECONNECT_MIN_MS;
        handler.current(null);
      };
      socket.onmessage = (e) => {
        try {
          const parsed = wsMessageSchema.safeParse(JSON.parse(String(e.data)));
          if (parsed.success) handler.current(parsed.data);
        } catch {
          // A malformed frame is dropped; the next message or reconnect refetches anyway.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [topic]);
}
