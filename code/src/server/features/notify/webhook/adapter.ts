import type { DeliverResult, Notification, Target } from "../../../../shared/notify";
import { getSecret } from "../../agents/api";
import { type Endpoint, requestEndpoint, safeEndpoint } from "../endpoint/api";
import type { Notifier } from "../port";
import { sign } from "./sign";

const TIMEOUT_MS = 5000;

function classify(status: number): DeliverResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 410) return { ok: false, retry: false, gone: true, reason: "receiver gone (410)" };
  if (status >= 500) return { ok: false, retry: true, reason: `receiver error ${status}` };
  // Redirects are failures: following one would walk past the address check.
  return { ok: false, retry: false, reason: `receiver answered ${status}` };
}

function payload(n: Notification, base: string): string {
  return JSON.stringify({
    kind: n.kind,
    orgId: n.orgId,
    title: n.title,
    body: n.body,
    url: new URL(n.path, base).href,
    tag: n.tag,
    at: Date.now(),
  });
}

async function post(
  endpoint: Endpoint,
  secret: string,
  n: Notification,
  base: string,
  timeoutMs: number,
): Promise<DeliverResult> {
  const body = payload(n, base);
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const status = await requestEndpoint(endpoint, {
      method: "POST",
      timeoutMs,
      headers: {
        "content-type": "application/json",
        "x-harness-timestamp": String(timestamp),
        "x-harness-signature": `sha256=${sign(secret, timestamp, body)}`,
        "x-harness-event": n.kind,
      },
      body,
    });
    return classify(status);
  } catch (err) {
    // Only the error class is reported: a message can echo the url.
    return {
      ok: false,
      retry: true,
      reason: `request failed (${err instanceof Error ? err.name : "error"})`,
    };
  }
}

export function webhookNotifier(home: string, timeoutMs: number = TIMEOUT_MS): Notifier {
  return {
    channel: "webhook",
    async deliver(target: Target, n: Notification, base: string): Promise<DeliverResult> {
      const { url, secretName } = target.value;
      const secret = secretName ? getSecret(secretName, home) : undefined;
      if (!url || !secret) return { ok: false, retry: false, reason: "webhook secret missing" };
      const check = await safeEndpoint(url);
      if (!check.ok) return { ok: false, retry: check.retry, reason: "webhook url refused" };
      return post(check.endpoint, secret, n, base, timeoutMs);
    },
  };
}
