import type { Server } from "bun";
import type { MiddlewareHandler } from "hono";

const MAX_TRACKED = 10_000;

// In memory on purpose: a restart resets the counters, and the throttle only has to slow guessing.
export function rateLimit(limit: number, windowMs: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const env = c.env as { server?: Server<unknown> } | undefined;
    const address = env?.server?.requestIP(c.req.raw)?.address ?? "unknown";
    const now = Date.now();
    if (hits.size > MAX_TRACKED) {
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    }
    const current = hits.get(address);
    const entry =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    hits.set(address, entry);
    if (entry.count > limit) {
      c.header("retry-after", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "too many attempts" }, 429);
    }
    await next();
  };
}
