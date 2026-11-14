import { createSignal, getOwner, onCleanup } from "solid-js";
import { z } from "zod";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// Frames only say "something changed"; the per-feature schemas arrive with the feature ports.
const frameSchema = z.object({ type: z.string() }).loose();
export type WsFrame = z.infer<typeof frameSchema>;

const STALLED_AFTER_MS = 10_000;
const [down, setDown] = createSignal(0);
const [stalled, setStalled] = createSignal(false);
const [online, setOnline] = createSignal(true);
const [lastLive, setLastLive] = createSignal(new Date());
let stallTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
// Registered on the first socket; bun's unit tests have a WebSocket stub but no window.
function watchOnline(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  setOnline(navigator.onLine);
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}

// Sockets that are closed right now. Moving between 0 and more starts or stops the "stalled" clock,
// so a short reconnect reads as reconnecting and a long one as offline.
function markDown(delta: 1 | -1): void {
  const next = down() + delta;
  setDown(next);
  if (next > 0 && delta === 1) stallTimer ??= setTimeout(() => setStalled(true), STALLED_AFTER_MS);
  if (next === 0) {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    setStalled(false);
    setLastLive(new Date());
  }
}

export type Connection = "live" | "reconnecting" | "offline";

// With no socket open anywhere there is nothing to be disconnected from, so that reads as live.
export const connection = (): Connection =>
  !online() || stalled() ? "offline" : down() > 0 ? "reconnecting" : "live";
export const lastLiveAt = lastLive;

// Messages are nudges to refetch. The handler also runs with null on every socket open, so whatever
// happened while the socket was down (or before it first connected) is picked up. Call inside a
// component or root: the socket closes when the owner is disposed.
export function createTopic(topic: string, onMessage: (frame: WsFrame | null) => void): void {
  if (!getOwner())
    throw new Error("createTopic needs a component or root, or its socket is never closed");
  watchOnline();
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let delay = RECONNECT_MIN_MS;
  let counted = false;
  const setCounted = (next: boolean): void => {
    if (next !== counted) markDown(next ? 1 : -1);
    counted = next;
  };
  const connect = (): void => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/ws?topic=${encodeURIComponent(topic)}`);
    socket.onopen = () => {
      delay = RECONNECT_MIN_MS;
      setCounted(false);
      setLastLive(new Date());
      onMessage(null);
    };
    socket.onmessage = (e) => {
      try {
        const parsed = frameSchema.safeParse(JSON.parse(String(e.data)));
        setLastLive(new Date());
        if (parsed.success) onMessage(parsed.data);
      } catch {
        // A malformed frame is dropped; the next message or reconnect refetches anyway.
      }
    };
    socket.onclose = () => {
      if (closed) return;
      setCounted(true);
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
  };
  connect();
  onCleanup(() => {
    closed = true;
    setCounted(false);
    clearTimeout(timer);
    socket?.close();
  });
}
