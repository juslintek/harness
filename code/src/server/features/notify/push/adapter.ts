import type { DeliverResult, Notification, Target } from "../../../../shared/notify";
import type { Notifier } from "../port";
import { encryptPayload } from "./encrypt";
import { vapidHeader } from "./vapid";

const TTL_S = "86400";
const TIMEOUT_MS = 10_000;

// Only the home is needed (for the VAPID key); declared here so adapters.ts can import this file.
interface PushEnv {
  home: string;
}

// Push services are https. Plain http is for the local stub in tests only, and only on loopback.
export function allowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
    return process.env.NODE_ENV === "test" && loopback;
  } catch {
    return false;
  }
}

export function decodeKeys(p256dh: string, auth: string): { ua: Buffer; auth: Buffer } | null {
  const ua = Buffer.from(p256dh, "base64url");
  const secret = Buffer.from(auth, "base64url");
  return ua.length === 65 && ua[0] === 4 && secret.length === 16 ? { ua, auth: secret } : null;
}

// The reason never includes the endpoint or keys: the endpoint is a capability url.
function fromStatus(status: number): DeliverResult {
  if (status >= 200 && status < 300) return { ok: true };
  const reason = `push service answered ${status}`;
  if (status === 404 || status === 410) return { ok: false, retry: false, gone: true, reason };
  return { ok: false, retry: status === 429 || status >= 500, reason };
}

async function send(
  env: PushEnv,
  target: Target,
  n: Notification,
  base: string,
): Promise<DeliverResult> {
  const { endpoint = "", p256dh = "", auth = "" } = target.value;
  const keys = decodeKeys(p256dh, auth);
  if (!keys || !allowedEndpoint(endpoint)) {
    return { ok: false, retry: false, gone: true, reason: "invalid push subscription" };
  }
  const subject = base.startsWith("https:") ? base : "mailto:push@localhost";
  const url = `${base}${n.path}`;
  const payload = JSON.stringify({ title: n.title, body: n.body, url, tag: n.tag });
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(env.home, endpoint, subject, Date.now()),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: TTL_S,
        Urgency: n.kind.startsWith("approval") ? "high" : "normal",
      },
      body: new Uint8Array(encryptPayload(Buffer.from(payload), keys.ua, keys.auth)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return fromStatus(res.status);
  } catch {
    return { ok: false, retry: true, reason: "push service unreachable" };
  }
}

export function pushNotifier(env: PushEnv): Notifier {
  return { channel: "push", deliver: (target, n, base) => send(env, target, n, base) };
}
