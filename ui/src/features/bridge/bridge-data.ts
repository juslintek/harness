import { z } from "zod";

export type Kind = "slack" | "telegram";

export interface Link {
  id: string;
  channelId: string;
  kind: Kind;
  externalId: string;
}

export const linksSchema: z.ZodType<Link[]> = z.array(
  z.object({
    id: z.string(),
    channelId: z.string(),
    kind: z.enum(["slack", "telegram"]),
    externalId: z.string(),
  }),
);

export const KIND_LABELS: Record<Kind, string> = { slack: "Slack", telegram: "Telegram" };
export const EXTERNAL_LABELS: Record<Kind, string> = {
  slack: "Slack channel id (starts with C)",
  telegram: "Telegram chat id",
};
