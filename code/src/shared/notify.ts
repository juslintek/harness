import { z } from "zod";

export const CHANNELS = ["push", "email", "slack", "telegram", "webhook"] as const;
export type Channel = (typeof CHANNELS)[number];

export const NOTIFY_KINDS = [
  "approval_requested",
  "approval_resolved",
  "mention",
  "dm",
  "run_blocked",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface Notification {
  kind: NotifyKind;
  orgId: string;
  title: string;
  body: string;
  path: string;
  tag: string;
}

export interface Target {
  id: string;
  channel: Channel;
  memberId: string;
  value: Record<string, string>;
}

export type DeliverResult =
  | { ok: true }
  | { ok: false; retry: boolean; gone?: boolean; reason: string };

// A webhook target shows its url only; the secret name and other values stay server side.
export interface TargetView {
  id: string;
  channel: Channel;
  label: string;
}

export interface PrefView {
  channel: Channel;
  kind: NotifyKind;
  enabled: boolean;
}

export const notificationSchema: z.ZodType<Notification> = z.object({
  kind: z.enum(NOTIFY_KINDS),
  orgId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(4000),
  path: z.string().startsWith("/"),
  tag: z.string().min(1).max(200),
});

export const prefSchema: z.ZodType<PrefView> = z.object({
  channel: z.enum(CHANNELS),
  kind: z.enum(NOTIFY_KINDS),
  enabled: z.boolean(),
});
