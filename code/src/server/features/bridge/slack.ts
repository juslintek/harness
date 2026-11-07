import { openSlackConnection, postSlackMessage } from "../notify/api";
import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, type Sleep, waitFor } from "./backoff";
import type { InboundMessage } from "./inbound";

export interface SocketOptions {
  home: string;
  onMessage: (msg: InboundMessage) => void;
  onLink?: (userId: string, code: string) => boolean;
  sleep?: Sleep;
  openConnection?: typeof openSlackConnection;
}

interface Envelope {
  envelope_id?: string;
  type?: string;
  payload?: SlackPayload;
}

interface SlackPayload {
  authorizations?: { user_id?: string }[];
  command?: string;
  text?: string;
  channel_id?: string;
  user_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
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

function handleLink(payload: SlackPayload | undefined, opts: SocketOptions): boolean {
  const event = payload?.event;
  if (event?.type !== "message" || event.subtype || event.bot_id || event.channel_type !== "im")
    return false;
  const code = event.text?.match(/^\/link(?:@\w+)?\s+(\S+)$/i)?.[1];
  if (!event.user || !event.channel || !code || !opts.onLink) return false;
  const linked = opts.onLink(event.user, code);
  void postSlackMessage(
    opts.home,
    event.channel,
    linked
      ? "Linked. Your messages in bridged Slack channels now appear in the app."
      : "That code is invalid, expired, or this Slack account is already linked.",
  );
  return true;
}

function handleSlashLink(payload: SlackPayload | undefined, opts: SocketOptions): void {
  if (payload?.command !== "/link" || !payload.channel_id?.startsWith("D")) return;
  const code = payload.text?.trim();
  if (!payload.user_id || !code || /\s/.test(code) || !opts.onLink) return;
  const linked = opts.onLink(payload.user_id, code);
  void postSlackMessage(
    opts.home,
    payload.channel_id,
    linked
      ? "Linked. Your messages in bridged Slack channels now appear in the app."
      : "That code is invalid, expired, or this Slack account is already linked.",
  );
}

function handleSocketMessage(ws: WebSocket, data: unknown, opts: SocketOptions): void {
  let env: Envelope;
  try {
    env = JSON.parse(String(data)) as Envelope;
  } catch {
    return;
  }
  if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
  if (env.type === "disconnect") ws.close();
  if (env.type === "slash_commands") {
    handleSlashLink(env.payload, opts);
    return;
  }
  if (env.type !== "events_api") return;
  if (handleLink(env.payload, opts)) return;
  const msg = toInbound(env.payload);
  if (msg) opts.onMessage(msg);
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
    ws.onmessage = (ev) => handleSocketMessage(ws, ev.data, opts);
    ws.onclose = () => resolve(opened);
    ws.onerror = () => resolve(opened);
  });
}

async function connectSlack(opts: SocketOptions, stop: AbortController): Promise<boolean> {
  const conn = await (opts.openConnection ?? openSlackConnection)(opts.home);
  if (stop.signal.aborted) return false;
  if ("url" in conn) return runSocket(conn.url, opts, stop.signal);
  console.error("slack bridge: connect failed:", conn.reason);
  return false;
}

// Outbound-only: the app dials Slack, so no public URL is needed. Stop closes the socket and
// resolves once the loop has ended.
export function startSlackSocket(opts: SocketOptions): () => Promise<void> {
  const stop = new AbortController();
  const sleep = opts.sleep ?? waitFor;
  const loop = (async () => {
    let delay = MIN_BACKOFF_MS;
    while (!stop.signal.aborted) {
      if (await connectSlack(opts, stop)) delay = MIN_BACKOFF_MS;
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
