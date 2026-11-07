import type { DeliverResult } from "../../../../shared/notify";
import { getSecret } from "../../agents/api";

const BOT_TOKEN = "slack.bot_token";
const APP_TOKEN = "slack.app_token";
const TRANSIENT = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

type Failure = { ok: false; retry: boolean; reason: string };
type Reply = { ok: true; data: Record<string, unknown> } | Failure;

function base(): string {
  return process.env.SLACK_API_URL ?? "https://slack.com";
}

// The token goes only into the Authorization header, but a proxy or a library error could echo
// it back, so every string leaving this file is scrubbed.
function scrub(text: string, token: string): string {
  return text.split(token).join("***");
}

function failure(res: Response, data: Record<string, unknown> | null, token: string): Failure {
  const error =
    typeof data?.error === "string" ? scrub(data.error, token).slice(0, 80) : `http ${res.status}`;
  const retry = res.status === 429 || res.status >= 500 || TRANSIENT.has(error);
  return { ok: false, retry, reason: scrub(`slack: ${error}`, token) };
}

async function call(method: string, token: string, body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch(`${base()}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data?.ok === true) return { ok: true, data };
    return failure(res, data, token);
  } catch {
    return { ok: false, retry: true, reason: "slack: unreachable" };
  }
}

export async function postSlackMessage(
  home: string,
  channel: string,
  text: string,
): Promise<DeliverResult> {
  const token = getSecret(BOT_TOKEN, home);
  if (!token) return { ok: false, retry: false, reason: "not configured" };
  const reply = await call("chat.postMessage", token, { channel, text });
  return reply.ok ? { ok: true } : reply;
}

// The returned URL carries a one-time ticket, so callers must not log it.
export async function openSlackConnection(home: string): Promise<Failure | { url: string }> {
  const token = getSecret(APP_TOKEN, home);
  if (!token) return { ok: false, retry: false, reason: "not configured" };
  const reply = await call("apps.connections.open", token, {});
  if (!reply.ok) return reply;
  const url = reply.data.url;
  return typeof url === "string" ? { url } : { ok: false, retry: true, reason: "slack: no url" };
}

export function slackConfigured(home: string): boolean {
  return Boolean(getSecret(BOT_TOKEN, home) && getSecret(APP_TOKEN, home));
}
