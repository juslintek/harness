import {
  CHANNELS,
  type Channel,
  NOTIFY_KINDS,
  type NotifyKind,
  type PrefView,
} from "../../../shared/notify";

export const CHANNEL_LABELS: Record<Channel, string> = {
  push: "Push",
  email: "Email",
  slack: "Slack",
  telegram: "Telegram",
  webhook: "Webhook",
};

export const KIND_LABELS: Record<NotifyKind, string> = {
  approval_requested: "Approval needed",
  approval_resolved: "Approval decided",
  mention: "Mentioned in chat",
  dm: "Direct message",
  run_blocked: "Run blocked",
};

export interface GridRow {
  kind: NotifyKind;
  cells: { channel: Channel; enabled: boolean }[];
}

// The server sends every kind x channel pair; a missing one reads as off so the grid never has holes.
export function gridRows(prefs: PrefView[]): GridRow[] {
  const on = new Set(prefs.filter((p) => p.enabled).map((p) => `${p.channel}:${p.kind}`));
  return NOTIFY_KINDS.map((kind) => ({
    kind,
    cells: CHANNELS.map((channel) => ({ channel, enabled: on.has(`${channel}:${kind}`) })),
  }));
}

export function withPref(prefs: PrefView[], next: PrefView): PrefView[] {
  const rest = prefs.filter((p) => !(p.channel === next.channel && p.kind === next.kind));
  return [...rest, next];
}

// The VAPID key arrives as unpadded base64url; pushManager.subscribe wants the raw bytes.
export function applicationServerKey(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type PushState = "unsupported" | "denied" | "subscribed" | "ready";

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | null;
  subscribed: boolean;
}

export function pushState(env: PushEnv): PushState {
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  if (env.permission === "denied") return "denied";
  return env.subscribed ? "subscribed" : "ready";
}

// iOS only exposes web push to a web app that was added to the home screen.
export function needsHomeScreen(userAgent: string, standalone: boolean): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) && !standalone;
}
