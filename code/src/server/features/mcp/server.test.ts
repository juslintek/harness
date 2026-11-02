import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { mcpHandler, mintRunToken, revokeRunTokens } from "./api";

let server: ReturnType<typeof Bun.serve>;
let token: string;
let db: ReturnType<typeof openDb>;
const reports: [string, string][] = [];

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, migrations);
  token = mintRunToken(db, "run-7", ["report"]);
  reports.length = 0;
  // the port is only known after listen, so the handler is built per request
  server = Bun.serve({
    port: 0,
    fetch: (req) => mcpHandler(db, (r, t) => reports.push([r, t]), server.port as number)(req),
  });
});
afterEach(() => {
  server.stop(true);
});

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/`), {
      requestInit: { headers },
    }),
  );
  return client;
}

test("no token gives 401", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST" });
  expect(res.status).toBe(401);
  const wrong = await fetch(`http://127.0.0.1:${server.port}/`, {
    method: "POST",
    headers: { authorization: "Bearer nope" },
  });
  expect(wrong.status).toBe(401);
});

test("bad Host gives 403", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`, {
    method: "POST",
    headers: { host: "evil.example:80", authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(403);
});

test("whoami returns runId", async () => {
  const client = await connect({ authorization: `Bearer ${token}` });
  const result = await client.callTool({ name: "whoami", arguments: {} });
  const content = result.content as { type: string; text: string }[];
  expect(JSON.parse(content[0]?.text ?? "")).toEqual({ runId: "run-7", scopes: ["report"] });
  await client.close();
});

test("report calls onReport and rejects oversize text", async () => {
  const client = await connect({ authorization: `Bearer ${token}` });
  await client.callTool({ name: "report", arguments: { text: "halfway" } });
  expect(reports).toEqual([["run-7", "halfway"]]);
  const big = await client.callTool({ name: "report", arguments: { text: "x".repeat(4001) } });
  expect(big.isError).toBe(true);
  expect(reports).toHaveLength(1);
  await client.close();
});

test("token without report scope cannot report", async () => {
  const client = await connect({
    authorization: `Bearer ${mintRunToken(db, "run-8", ["guard_hook"])}`,
  });
  const result = await client.callTool({ name: "report", arguments: { text: "hi" } });
  expect(result.isError).toBe(true);
  expect(reports).toHaveLength(0);
  await client.close();
});

test("revoked token gets 401 over http", async () => {
  revokeRunTokens(db, "run-7");
  const res = await fetch(`http://127.0.0.1:${server.port}/`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(401);
});

test("GET and DELETE get 405", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  }
});
