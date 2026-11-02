import { expect, test } from "bun:test";
import { healthSchema } from "../shared/health";
import { createApp } from "./http";

test("GET /api/health returns the instance id and version", async () => {
  const app = createApp({ instanceId: "abc", version: "1.2.3" });
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  expect(healthSchema.parse(await res.json())).toEqual({
    ok: true,
    instanceId: "abc",
    version: "1.2.3",
  });
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
