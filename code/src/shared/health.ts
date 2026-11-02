import { z } from "zod";

export const healthSchema: z.ZodObject<{
  ok: z.ZodLiteral<true>;
  instanceId: z.ZodString;
  version: z.ZodString;
}> = z.object({
  ok: z.literal(true),
  instanceId: z.string(),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;
