import { expect, test } from "bun:test";
import { pwaResponse } from "./pwa";

test("manifest is served as a web manifest starting at /", async () => {
  const res = pwaResponse("/manifest.webmanifest");
  if (!res) throw new Error("no manifest route");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/manifest+json");
  expect((await res.json()).start_url).toBe("/");
});

test("service worker is javascript, never cached, and may control /", async () => {
  const res = pwaResponse("/sw.js");
  expect(res?.status).toBe(200);
  expect(res?.headers.get("content-type")).toContain("javascript");
  expect(res?.headers.get("cache-control")).toBe("no-cache");
  expect(res?.headers.get("service-worker-allowed")).toBe("/");
});

test("icon is svg and other paths fall through", () => {
  expect(pwaResponse("/icon.svg")?.headers.get("content-type")).toBe("image/svg+xml");
  expect(pwaResponse("/api/health")).toBeNull();
});
