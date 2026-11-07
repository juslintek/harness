import { expect, test } from "bun:test";
import { flow } from "../../test-support/oauth-kit";

test("remote MCP supports browser preflights, discovery errors and bearer initialization", async () => {
  const { kit, tokens } = await flow();
  const browser = "https://browser-client.example";
  const headers = { host: "localhost:4100", origin: browser };
  const preflight = await kit.api.app.request("/mcp/remote", {
    method: "OPTIONS",
    headers: {
      ...headers,
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "authorization,content-type,mcp-protocol-version,mcp-session-id",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  for (const name of ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"]) {
    expect(preflight.headers.get("access-control-allow-headers")).toContain(name);
  }
  const noToken = await kit.api.app.request("/mcp/remote", { method: "POST", headers });
  expect(noToken.status).toBe(401);
  expect(noToken.headers.get("access-control-allow-origin")).toBe("*");
  expect(noToken.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  expect(noToken.headers.get("www-authenticate")).toContain("resource_metadata");
  const initialized = await kit.api.app.request("/mcp/remote", {
    method: "POST",
    headers: {
      ...headers,
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "browser", version: "1" },
      },
    }),
  });
  expect(initialized.status).toBe(200);
  expect(initialized.headers.get("access-control-allow-origin")).toBe("*");
  expect(initialized.headers.get("access-control-allow-credentials")).toBeNull();
  expect((await initialized.json()).result.serverInfo.name).toBe("harness");
  for (const path of ["/mcp/local", "/api/auth/me"]) {
    const local = await kit.api.app.request(path, { method: "OPTIONS", headers });
    expect(local.headers.get("access-control-allow-origin")).toBeNull();
  }
  const forgedHost = await kit.api.app.request("/mcp/remote", {
    method: "OPTIONS",
    headers: { ...headers, host: "evil.example" },
  });
  expect(forgedHost.status).toBe(403);
});
