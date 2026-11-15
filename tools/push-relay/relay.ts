import { createHmac, timingSafeEqual } from "node:crypto";

export interface RelayConfig {
  secret?: string;
  apnsEndpoint?: string;
  apnsTopic?: string;
  fcmEndpoint?: string;
  fcmProjectId?: string;
  fcmToken?: string;
  fetch?: typeof fetch;
}

interface Envelope {
  version: number;
  platform: "ios" | "android";
  appId: string;
  pushToken: string;
  kind: string;
  urgency: "time-sensitive" | "active";
  tag: string;
  deepLink: string;
  instanceOrigin: string;
  ts: number;
}

const TITLES: Record<string, { title: string; body: string }> = {
  approval_requested: { title: "Approval Requested", body: "Action requires your approval" },
  approval_resolved: { title: "Approval Resolved", body: "An approval was resolved" },
  run_blocked: { title: "Run Blocked", body: "An agent run is blocked" },
  mention: { title: "New Mention", body: "You were mentioned" },
  dm: { title: "New Message", body: "You received a direct message" },
};

function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function parseEnvelope(raw: string): Envelope | null {
  try {
    const o = JSON.parse(raw);
    if (o.version !== 1 || (o.platform !== "ios" && o.platform !== "android")) return null;
    if (!o.appId || !o.pushToken || !o.kind || !o.urgency || !o.deepLink || !o.instanceOrigin) {
      return null;
    }
    return o as Envelope;
  } catch {
    return null;
  }
}

async function sendApns(
  config: RelayConfig,
  fetchFn: typeof fetch,
  env: Envelope,
): Promise<Response> {
  const url = config.apnsEndpoint ?? `https://api.push.apple.com/3/device/${env.pushToken}`;
  const alert = TITLES[env.kind] ?? { title: "Harness Notification", body: "New notification" };
  const payload = {
    aps: {
      alert,
      "interruption-level": env.urgency,
      "mutable-content": 1,
      sound: "default",
    },
    deepLink: env.deepLink,
    instanceOrigin: env.instanceOrigin,
    kind: env.kind,
    tag: env.tag,
  };
  return fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apns-push-type": "alert",
      "apns-priority": env.urgency === "time-sensitive" ? "10" : "5",
      "apns-topic": config.apnsTopic ?? env.appId,
    },
    body: JSON.stringify(payload),
  });
}

async function sendFcm(config: RelayConfig, fetchFn: typeof fetch, env: Envelope): Promise<Response> {
  const project = config.fcmProjectId ?? "default";
  const url = config.fcmEndpoint ?? `https://fcm.googleapis.com/v1/projects/${project}/messages:send`;
  const payload = {
    message: {
      token: env.pushToken,
      android: { priority: "HIGH" },
      data: {
        deepLink: env.deepLink,
        instanceOrigin: env.instanceOrigin,
        kind: env.kind,
        urgency: env.urgency,
        tag: env.tag,
      },
    },
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.fcmToken) headers.authorization = `Bearer ${config.fcmToken}`;
  return fetchFn(url, { method: "POST", headers, body: JSON.stringify(payload) });
}

export function createRelayHandler(config: RelayConfig): (req: Request) => Promise<Response> {
  const fetchFn = config.fetch ?? fetch;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const rawBody = await req.text();

    if (config.secret && !verifySignature(config.secret, rawBody, req.headers.get("x-harness-push-signature"))) {
      return new Response(JSON.stringify({ error: "invalid signature" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const env = parseEnvelope(rawBody);
    if (!env) {
      return new Response(JSON.stringify({ error: "invalid envelope" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    try {
      const res = env.platform === "ios" ? await sendApns(config, fetchFn, env) : await sendFcm(config, fetchFn, env);
      if (res.status === 410 || res.status === 404) {
        return new Response(JSON.stringify({ gone: true, reason: "unregistered" }), {
          status: 410,
          headers: { "content-type": "application/json" },
        });
      }
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `upstream answered ${res.status}` }), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "relay upstream unreachable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  };
}
