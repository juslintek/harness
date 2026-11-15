import { createHmac } from "node:crypto";
import type { DeliverResult, Notification, Target } from "../../../../shared/notify";
import { getSecret } from "../../agents/api";
import { requestEndpoint, safeEndpoint } from "../endpoint/api";

const TIMEOUT_MS = 10_000;

export function deepLinkFor(n: Notification): string {
  let path = n.path.replace(/^\//, "");
  if (path.startsWith("#/")) path = path.slice(1);
  const approvals = path.match(/^\/approvals\/(.+)$/);
  if (approvals?.[1]) return `harness://approvals/${approvals[1]}`;
  const chat = path.match(/^\/o\/([^/]+)\/chat\/(.+)$/);
  if (chat?.[1] && chat?.[2]) return `harness://chat/${chat[1]}/${chat[2]}`;
  const runs = path.match(/^\/runs\/(.+)$/);
  if (runs?.[1]) return `harness://runs/${runs[1]}`;
  return `harness://open?path=${encodeURIComponent(n.path)}`;
}

function fromRelayStatus(status: number): DeliverResult {
  if (status >= 200 && status < 300) return { ok: true };
  const reason = `push relay answered ${status}`;
  if (status === 404 || status === 410) {
    return { ok: false, retry: false, gone: true, reason };
  }
  return { ok: false, retry: status === 429 || status >= 500, reason };
}

interface PushEnv {
  home: string;
}

export async function deliverMobilePush(
  env: PushEnv,
  target: Target,
  n: Notification,
  base: string,
  checkEndpoint: typeof safeEndpoint = safeEndpoint,
): Promise<DeliverResult> {
  const { relayUrl = "", platform = "ios", appId = "", pushToken = "", secretName } = target.value;
  const check = await checkEndpoint(relayUrl);
  if (!check.ok) {
    return {
      ok: false,
      retry: check.retry,
      ...(!check.retry ? { gone: true } : {}),
      reason: "invalid relay url",
    };
  }

  const urgency =
    n.kind === "approval_requested" || n.kind === "run_blocked" ? "time-sensitive" : "active";
  const envelope = {
    version: 1,
    platform,
    appId,
    pushToken,
    kind: n.kind,
    urgency,
    tag: n.tag,
    deepLink: deepLinkFor(n),
    instanceOrigin: base,
    ts: Date.now(),
  };
  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "harness-push-relay",
  };

  const secret = secretName ? getSecret(secretName, env.home) : target.value.relaySecret;
  if (secret) {
    headers["x-harness-push-signature"] =
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  }

  try {
    const status = await requestEndpoint(check.endpoint, {
      method: "POST",
      timeoutMs: TIMEOUT_MS,
      headers,
      body,
    });
    return fromRelayStatus(status);
  } catch {
    return { ok: false, retry: true, reason: "push relay unreachable" };
  }
}
