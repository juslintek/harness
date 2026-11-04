import { getOwner, onCleanup } from "solid-js";
import { z } from "zod";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// Frames only say "something changed"; the per-feature schemas arrive with the feature ports.
const frameSchema = z.object({ type: z.string() }).loose();
export type WsFrame = z.infer<typeof frameSchema>;

// Messages are nudges to refetch. The handler also runs with null on every socket open, so whatever
// happened while the socket was down (or before it first connected) is picked up. Call inside a
// component or root: the socket closes when the owner is disposed.
export function createTopic(topic: string, onMessage: (frame: WsFrame | null) => void): void {
  if (!getOwner())
    throw new Error("createTopic needs a component or root, or its socket is never closed");
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let delay = RECONNECT_MIN_MS;
  const connect = (): void => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/ws?topic=${encodeURIComponent(topic)}`);
    socket.onopen = () => {
      delay = RECONNECT_MIN_MS;
      onMessage(null);
    };
    socket.onmessage = (e) => {
      try {
        const parsed = frameSchema.safeParse(JSON.parse(String(e.data)));
        if (parsed.success) onMessage(parsed.data);
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
  onCleanup(() => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
  });
}
