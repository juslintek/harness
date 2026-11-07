import { expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { bootApi } from "../../test-support/api-kit";
import { mintLocalLinkToken } from "../oauth/api";

async function localRequest() {
  const kit = bootApi();
  const owner = await kit.user({ admin: true });
  const org = kit.org(owner, "local");
  const token = mintLocalLinkToken(kit.db, org.owner.id, org.id);
  const init: RequestInit = {
    method: "POST",
    headers: {
      host: "127.0.0.1:4100",
      authorization: `Bearer ${token}`,
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
        clientInfo: { name: "test", version: "1" },
      },
    }),
  };
  return { ...kit, init };
}

test("the local MCP route refuses missing or remote peers even with a valid token and forged Host", async () => {
  const { app, init } = await localRequest();
  const request = () => new Request("http://127.0.0.1:4100/mcp/local", init);
  expect((await app.fetch(request())).status).toBe(403);
  for (const address of ["192.0.2.1", "::ffff:192.0.2.1"]) {
    const server = { requestIP: () => ({ address }) };
    expect((await app.fetch(request(), { server })).status).toBe(403);
  }
  const server = { requestIP: () => ({ address: "127.0.0.1" }) };
  expect((await app.fetch(request(), { server })).status).toBe(200);
  const proxied = request();
  proxied.headers.set("x-forwarded-for", "127.0.0.1");
  expect((await app.fetch(proxied, { server })).status).toBe(403);
  const publicHost = request();
  publicHost.headers.set("host", "localhost:4100");
  expect((await app.fetch(publicHost, { server })).status).toBe(403);
});

test("a listener bound to all interfaces rejects an actual nonloopback peer forging loopback Host", async () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((ip) => ip?.family === "IPv4" && !ip.internal)?.address;
  if (!address) throw new Error("this regression needs a nonloopback IPv4 interface");
  const { app, init } = await localRequest();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (req, srv) => app.fetch(req, { server: srv }),
  });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/mcp/local`, init)).status).toBe(200);
    expect((await fetch(`http://${address}:${server.port}/mcp/local`, init)).status).toBe(403);
  } finally {
    await server.stop(true);
  }
});
