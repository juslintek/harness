import { z } from "zod";
import { type ProfileView, selfCardSchema } from "../../../shared/profiles";

export const profileViewSchema: z.ZodType<ProfileView> = z.object({
  id: z.string(),
  orgId: z.string(),
  runtime: z.string(),
  model: z.string().nullable(),
  persona: z.string(),
  skills: z.array(z.string()),
  scope: z.object({ readOnly: z.boolean() }),
  fallbacks: z.array(z.object({ runtime: z.string(), model: z.string().nullable() })),
  card: selfCardSchema.nullable(),
  cardAt: z.number().nullable(),
});
