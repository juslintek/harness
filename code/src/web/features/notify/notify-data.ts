import { z } from "zod";
import { CHANNELS, type PrefView, prefSchema, type TargetView } from "../../../shared/notify";

export const prefsSchema: z.ZodType<PrefView[]> = z.array(prefSchema);

export const targetsSchema: z.ZodType<TargetView[]> = z.array(
  z.object({ id: z.string(), channel: z.enum(CHANNELS), label: z.string() }),
);

export const createdSchema: z.ZodType<{ id: string }> = z.object({ id: z.string() });

export const pushKeySchema: z.ZodType<{ key: string }> = z.object({ key: z.string() });

// What `PushSubscription.toJSON()` must hold before it is sent: the browser types every field optional.
export const subscriptionSchema: z.ZodType<{
  endpoint: string;
  keys: { p256dh: string; auth: string };
}> = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export interface WebhookAdded {
  id: string;
  secret: string;
  note: string;
}

export const webhookAddedSchema: z.ZodType<WebhookAdded> = z.object({
  id: z.string(),
  secret: z.string(),
  note: z.string(),
});
