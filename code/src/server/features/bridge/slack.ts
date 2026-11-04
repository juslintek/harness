import { openSlackConnection } from "../notify/api";
import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, type Sleep, waitFor } from "./backoff";
import type { InboundMessage } from "./inbound";

export interface SocketOptions {
  home: string;
  onMessage: (msg: InboundMessage) => void;
  sleep?: Sleep;
}

interface Envelope {
  envelope_id?: string;
  type?: string;
  payload?: SlackPayload;
}

interface SlackPayload {
  authorizations?: { user_id?: string }[];
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
  };
}

// Only plain human messages count: edits, deletes, joins and bot posts (including our own
// echoes) carry a subtype or a bot id.
function toInbound(payload: SlackPayload | undefined): InboundMessage | null {
  const e = payload?.event;
  if (e?.type !== "message" || e.subtype || e.bot_id) return null;
  if (!e.user || !e.channel || !e.text) return null;
  if (payload?.authorizations?.some((a) => a.user_id === e.user)) return null;
  return { kind: "slack", externalChannel: e.channel, externalUser: e.user, text: e.text };
}

// Resolves when the socket closes; true if it ever opened, so the caller can reset its backoff.
function runSocket(url: string, opts: SocketOptions, stop: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let opened = false;
    stop.addEventListener("abort", () => ws.close(), { once: true });
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev) => {
      let env: Envelope;
      try {
        env = JSON.parse(String(ev.data)) as Envelope;
      } catch {
        return;
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === "disconnect") ws.close();
      if (env.type !== "events_api") return;
      const msg = toInbound(env.payload);
      if (msg) opts.onMessage(msg);
    };
    ws.onclose = () => resolve(opened);
    ws.onerror = () => resolve(opened);
  });
}

// Outbound-only: the app dials Slack, so no public URL is needed. Stop closes the socket and
// resolves once the loop has ended.
export function startSlackSocket(opts: SocketOptions): () => Promise<void> {
  const stop = new AbortController();
  const sleep = opts.sleep ?? waitFor;
  const loop = (async () => {
    let delay = MIN_BACKOFF_MS;
    while (!stop.signal.aborted) {
      const conn = await openSlackConnection(opts.home);
      if ("url" in conn) {
        if (await runSocket(conn.url, opts, stop.signal)) delay = MIN_BACKOFF_MS;
      } else {
        console.error("slack bridge: connect failed:", conn.reason);
      }
      if (stop.signal.aborted) break;
      await sleep(delay, stop.signal);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  })();
  return async () => {
    stop.abort();
    await loop;
  };
}
