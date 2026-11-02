import { z } from "zod";

export const searchQuerySchema: z.ZodObject<{ q: z.ZodString }> = z.object({
  q: z.string().trim().min(1).max(200),
});

export const usageQuerySchema: z.ZodObject<{
  by: z.ZodDefault<z.ZodEnum<{ agent: "agent"; model: "model"; run: "run" }>>;
  since: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}> = z.object({
  by: z.enum(["agent", "model", "run"]).default("agent"),
  since: z.coerce.number().int().min(0).default(0),
});
