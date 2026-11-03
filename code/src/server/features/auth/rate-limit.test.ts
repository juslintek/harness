import { expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit";

function appWith(
  trustProxy: boolean,
): (forwarded: string | null, socket: string) => Promise<number> {
  const app = new Hono();
  app.use("*", rateLimit(1, 60_000, trustProxy));
  app.get("/", (c) => c.text("ok"));
  return async (forwarded, socket) => {
    const env = { server: { requestIP: () => ({ address: socket }) } };
    const headers = forwarded === null ? {} : { "x-forwarded-for": forwarded };
    return (await app.request("/", { headers }, env)).status;
  };
}

test("without a trusted proxy the header is ignored and the socket address is the key", async () => {
  const hit = appWith(false);
  expect(await hit("1.1.1.1", "9.9.9.9")).toBe(200);
  expect(await hit("2.2.2.2", "9.9.9.9")).toBe(429);
  expect(await hit("2.2.2.2", "8.8.8.8")).toBe(200);
});

test("behind a trusted proxy the rightmost forwarded address is the key", async () => {
  const hit = appWith(true);
  expect(await hit("spoofed-1, 3.3.3.3", "9.9.9.9")).toBe(200);
  expect(await hit("spoofed-2, 3.3.3.3", "9.9.9.9")).toBe(429);
  expect(await hit("spoofed-1, 4.4.4.4", "9.9.9.9")).toBe(200);
  expect(await hit(null, "5.5.5.5")).toBe(200);
  expect(await hit(null, "5.5.5.5")).toBe(429);
});
