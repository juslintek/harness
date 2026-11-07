import { z } from "zod";

export const linkCodeSchema: z.ZodType<{ code: string; expiresAt: number }> = z.object({
  code: z.string(),
  expiresAt: z.number(),
});
