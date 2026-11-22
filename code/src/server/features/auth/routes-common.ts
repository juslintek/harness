import type { Context } from "hono";
import type { z } from "zod";

export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export const invalidBody = (c: Context): Response => c.json({ error: "invalid body" }, 400);
