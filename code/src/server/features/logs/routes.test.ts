import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";

test("org log search is member-only and rejects a bad kind", async () => {
  const k = bootApi();
  const owner = await k.user();
  const stranger = await k.user();
  k.org(owner, "acme");
  const ok = await k.call(owner, "GET", "/api/orgs/acme/logs/search?q=deploy");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual([]);
  expect((await k.call(owner, "GET", "/api/orgs/acme/logs/search?q=x&kind=nope")).status).toBe(400);
  expect((await k.call(stranger, "GET", "/api/orgs/acme/logs/search?q=deploy")).status).toBe(403);
});
