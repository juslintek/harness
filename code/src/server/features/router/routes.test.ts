import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { onQuotaRecorded, probeQuota } from "../usage/api";

test("POST /api/quota records a manual snapshot, tells listeners and validates the body", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  const seen: Array<string | null> = [];
  const off = onQuotaRecorded((q) => seen.push(`${q.provider}:${q.usedPercent}`));
  const body = { provider: "claude", window: "five_hour", usedPercent: 100, resetsAt: 9e12 };
  expect((await kit.call(admin, "POST", "/api/quota", body)).status).toBe(200);
  expect((await kit.call(admin, "POST", "/api/quota", { ...body, usedPercent: 101 })).status).toBe(
    400,
  );
  off();
  expect(seen).toEqual(["claude:100"]);
  const view = await probeQuota(kit.db);
  expect(view.find((q) => q.provider === "claude")).toMatchObject({
    window: "five_hour",
    usedPercent: 100,
    source: "manual",
  });
  const plain = await kit.user({ admin: false });
  expect((await kit.call(plain, "POST", "/api/quota", body)).status).toBe(403);
});

test("GET /api/router/route needs a member and is admin only", async () => {
  const kit = bootApi();
  const admin = await kit.user({ admin: true });
  expect((await kit.call(admin, "GET", "/api/router/route")).status).toBe(400);
  const plain = await kit.user({ admin: false });
  expect((await kit.call(plain, "GET", "/api/router/route?member=x")).status).toBe(403);
});
