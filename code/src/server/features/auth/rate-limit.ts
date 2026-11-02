import type { Server } from "bun";
import type { Context, MiddlewareHandler } from "hono";

const MAX_TRACKED = 10_000;

// Behind a proxy the socket address is the proxy's, so the key is the rightmost X-Forwarded-For
// entry: the one the proxy itself appended, which the client cannot forge. Without a proxy the
// header is ignored.
function clientKey(c: Context, trustProxy: boolean): string {
  const env = c.env as { server?: Server<unknown> } | undefined;
  const socket = env?.server?.requestIP(c.req.raw)?.address ?? "unknown";
  if (!trustProxy) return socket;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded || socket;
}

// In memory on purpose: a restart resets the counters, and the throttle only has to slow guessing.
export function rateLimit(limit: number, windowMs: number, trustProxy = false): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const address = clientKey(c, trustProxy);
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
