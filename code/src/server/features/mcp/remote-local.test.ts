import { expect, test } from "bun:test";
import { flow } from "../../test-support/oauth-kit";
import { mintLocalLinkToken } from "../oauth/api";

test("Desktop tokens only open /mcp/local on a literal loopback Host", async () => {
  const { kit, tokens } = await flow();
  const desktop = mintLocalLinkToken(kit.api.db, kit.org.owner.id, kit.org.id);
  expect(
    (
      await kit.api.app.request("/mcp/remote", {
        method: "POST",
        headers: { host: "localhost:4100", authorization: `Bearer ${desktop}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await kit.api.app.request("/mcp/local", {
        method: "POST",
        headers: { host: "localhost:4100", authorization: `Bearer ${desktop}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await kit.api.app.request(
        "/mcp/local",
        {
          method: "POST",
          headers: { host: "127.0.0.1:4100", authorization: `Bearer ${tokens.access_token}` },
        },
        { server: { requestIP: () => ({ address: "127.0.0.1" }) } },
      )
    ).status,
  ).toBe(401);
  for (const headers of [
    { "x-forwarded-host": "public.example" },
    { "x-forwarded-proto": "https" },
    { forwarded: "host=public.example" },
    { via: "1.1 public-proxy" },
  ]) {
    const res = await kit.api.app.request(
      "/mcp/local",
      {
        method: "POST",
        headers: { host: "127.0.0.1:4100", authorization: `Bearer ${desktop}`, ...headers },
      },
      { server: { requestIP: () => ({ address: "127.0.0.1" }) } },
    );
    expect(res.status).toBe(403);
  }
});
