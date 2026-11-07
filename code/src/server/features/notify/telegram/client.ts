import type { DeliverResult } from "../../../../shared/notify";
import { getSecret } from "../../agents/api";

const BOT_TOKEN = "telegram.bot_token";

export type Failure = Extract<DeliverResult, { ok: false }>;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
  };
}

const notConfigured: Failure = { ok: false, retry: false, reason: "not configured" };

function base(): string {
  return process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
}

// The token is part of the URL path, so a proxy or a library error can echo it back: every
// string leaving this file is scrubbed.
function failure(res: Response, data: Record<string, unknown> | null, token: string): Failure {
  const text =
    typeof data?.description === "string"
      ? data.description.replaceAll(token, "***").slice(0, 120)
      : "";
  const reason = `telegram: ${res.status} ${text}`.trim().replaceAll(token, "***");
  // 403 means the user blocked the bot or it was removed from the chat: it will never work again.
  if (res.status === 403) return { ok: false, retry: false, gone: true, reason };
  return { ok: false, retry: res.status === 429 || res.status >= 500, reason };
}

interface Call {
  method: string;
  signal: AbortSignal;
  query?: string;
  body?: Record<string, unknown>;
}

async function call(token: string, c: Call): Promise<Failure | { ok: true; result: unknown }> {
  const url = `${base()}/bot${token}/${c.method}${c.query ? `?${c.query}` : ""}`;
  try {
    const init: RequestInit = c.body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(c.body),
        }
      : { method: "GET" };
    const res = await fetch(url, { ...init, signal: c.signal });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data?.ok === true) return { ok: true, result: data.result };
    return failure(res, data, token);
  } catch {
    // A fetch error message can contain the URL, so none of it is passed on.
    return { ok: false, retry: true, reason: "telegram: unreachable" };
  }
}

export async function sendTelegramMessage(
  home: string,
  chatId: string,
  text: string,
): Promise<DeliverResult> {
  const token = getSecret(BOT_TOKEN, home);
  if (!token) return notConfigured;
  const reply = await call(token, {
    method: "sendMessage",
    body: { chat_id: chatId, text },
    signal: AbortSignal.timeout(10_000),
  });
  return reply.ok ? { ok: true } : reply;
}

// Long poll: Telegram holds the request up to `timeout` seconds, so the abort window is longer.
export async function getTelegramUpdates(
  home: string,
  offset: number,
  stop: AbortSignal,
): Promise<Failure | { ok: true; updates: TelegramUpdate[] }> {
  const token = getSecret(BOT_TOKEN, home);
  if (!token) return notConfigured;
  const reply = await call(token, {
    method: "getUpdates",
    query: `timeout=25&offset=${offset}`,
    signal: AbortSignal.any([stop, AbortSignal.timeout(40_000)]),
  });
  if (!reply.ok) return reply;
  const updates = Array.isArray(reply.result) ? (reply.result as TelegramUpdate[]) : [];
  return { ok: true, updates };
}

export function telegramConfigured(home: string): boolean {
  return Boolean(getSecret(BOT_TOKEN, home));
}
