import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { api } from "../kit/client";
import { type SeededSession, seedSession } from "../kit/seed";
import { commandFor, lazyBoot } from "../kit/server";

const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET = process.env.HARNESS_TARGET ?? "ts";

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const runTokens = {} as Record<"report" | "guardOnly", string>;
let session: SeededSession;

function seedRunToken(db: Database, runId: string, scopes: string[]): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query("INSERT INTO run_tokens (hash, run_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
    sha256Hex(token),
    runId,
    JSON.stringify(scopes),
    Date.now() - DAY_MS,
  );
  return token;
}

const lazy = lazyBoot({
  seed: (db) => {
    session = seedSession(db, { admin: true });
    runTokens.report = seedRunToken(db, "run-7", ["report"]);
    runTokens.guardOnly = seedRunToken(db, "run-8", ["guard_hook"]);
  },
});
afterAll(() => lazy.stop());

const RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function connect(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "conformance", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function rpc(
  port: number,
  token: string | null,
  body: unknown,
  extra = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...RPC_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]?.text ?? "";
}

test("C2-mcp-sdk: whoami, report and the tool list through the SDK client [phase:2] [slice:mcp] [focus:1]", async () => {
  const server = await lazy.get();
  const client = await connect(server.port, runTokens.report);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("whoami");
    expect(names).toContain("report");
    expect(names).toHaveLength(new Set(names).size);
    const whoami = await client.callTool({ name: "whoami", arguments: {} });
    expect(JSON.parse(textOf(whoami))).toEqual({ runId: "run-7", scopes: ["report"] });

    const sent = await client.callTool({ name: "report", arguments: { text: "halfway there" } });
    expect(textOf(sent)).toBe("ok");
    const big = await client.callTool({ name: "report", arguments: { text: "x".repeat(4001) } });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toBe(
      "MCP error -32602: Input validation error: Invalid arguments for tool report: Too big: expected string to have <=4000 characters at text",
    );
    const unknown = await client.callTool({ name: "nope", arguments: {} });
    expect(textOf(unknown)).toBe("MCP error -32602: Tool nope not found");
  } finally {
    await client.close();
  }

  const db = new Database(join(server.home, "harness.db"), { readonly: true });
  try {
    const rows = db
      .query<{ run_id: string; kind: string }, []>(
        "SELECT run_id, kind FROM events WHERE source = 'mcp'",
      )
      .all();
    expect(rows).toEqual([{ run_id: "run-7", kind: "message" }]);
  } finally {
    db.close();
  }
});

test("C2-mcp-scope: a token without the scope cannot report [phase:2] [slice:mcp] [focus:1]", async () => {
  const server = await lazy.get();
  const client = await connect(server.port, runTokens.guardOnly);
  try {
    const result = await client.callTool({ name: "report", arguments: { text: "hi" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("token lacks report scope");
  } finally {
    await client.close();
  }
});

test("C2-mcp-wire: protocol negotiation and errors [phase:2] [slice:mcp] [focus:1]", async () => {
  const server = await lazy.get();
  const init = (version: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "c", version: "1" } },
  });
  for (const [asked, answered] of [
    ["2025-06-18", "2025-06-18"],
    ["2024-11-05", "2024-11-05"],
    ["1999-01-01", "2025-11-25"],
  ] as const) {
    const res = await rpc(server.port, runTokens.report, init(asked));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(await res.json()).toEqual({
      result: {
        protocolVersion: answered,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "harness", version: "1.0.0" },
      },
      jsonrpc: "2.0",
      id: 1,
    });
  }
  const discover = await rpc(server.port, runTokens.report, {
    jsonrpc: "2.0",
    id: 2,
    method: "server/discover",
  });
  expect(await discover.json()).toEqual({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32601, message: "Method not found" },
  });
  const ping = await rpc(server.port, runTokens.report, { jsonrpc: "2.0", id: 3, method: "ping" });
  expect(await ping.json()).toEqual({ result: {}, jsonrpc: "2.0", id: 3 });
  const note = await rpc(server.port, runTokens.report, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(note.status).toBe(202);
  const bad = await rpc(server.port, runTokens.report, "{nope");
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({
    jsonrpc: "2.0",
    error: { code: -32700, message: "Parse error: Invalid JSON" },
    id: null,
  });
  const noAccept = await rpc(server.port, runTokens.report, init("2025-06-18"), {
    accept: "application/json",
  });
  expect(noAccept.status).toBe(406);
});

test("C2-mcp-auth: bearer, host and method guards [phase:2] [slice:mcp] [focus:1]", async () => {
  const server = await lazy.get();
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const unauthorized = await rpc(server.port, null, { jsonrpc: "2.0", id: 1, method: "ping" });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
  expect(await unauthorized.text()).toBe("unauthorized");
  expect((await rpc(server.port, "nope", "{}")).status).toBe(401);
  const host = await fetch(url, {
    method: "POST",
    headers: { ...RPC_HEADERS, host: "evil.example", authorization: `Bearer ${runTokens.report}` },
    body: "{}",
  });
  expect(host.status).toBe(403);
  for (const method of ["GET", "DELETE", "PUT"]) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${runTokens.report}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  }
});

test("C2-mcp-surfaces: a session cookie is refused on /mcp and a run token on /api [phase:2] [slice:mcp] [focus:1]", async () => {
  const server = await lazy.get();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const withCookie = await rpc(server.port, null, ping, { cookie: session.cookie });
  expect(withCookie.status).toBe(401);
  const sessionAsBearer = await rpc(server.port, session.token, ping, { cookie: session.cookie });
  expect(sessionAsBearer.status).toBe(401);

  // The session is real: the same cookie opens /api.
  expect((await api(server, session).call("GET", "/api/auth/me")).status).toBe(200);
  const bearer = await api(server).call("GET", "/api/auth/me", {
    headers: { authorization: `Bearer ${runTokens.report}` },
  });
  expect(bearer.status).toBe(401);
  expect(await bearer.json()).toEqual({ error: "unauthorized" });
  const asCookie = await api(server).call("GET", "/api/auth/me", {
    headers: { cookie: `harness_session=${runTokens.report}` },
  });
  expect(asCookie.status).toBe(401);
});

// The TS server has no stdio mode; `harness mcp-stdio` is part of the Zig binary only.
if (TARGET === "zig") {
  test("C2-mcp-stdio: the stdio proxy relays lines to /mcp with the token from the environment [phase:2] [slice:mcp] [focus:1]", async () => {
    const server = await lazy.get();
    const bin = commandFor("zig").argv[0] ?? "";
    const proc = Bun.spawn([bin, "mcp-stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HARNESS_MCP_TOKEN: runTokens.report,
        HARNESS_MCP_URL: `http://127.0.0.1:${server.port}/mcp`,
      },
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ];
    proc.stdin.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await proc.stdin.end();
    const out = (await new Response(proc.stdout).text()).trim().split("\n");
    expect(await proc.exited).toBe(0);
    expect(out).toHaveLength(2);
    expect(JSON.parse(textOf(JSON.parse(out[0] ?? "").result))).toEqual({
      runId: "run-7",
      scopes: ["report"],
    });
    expect(JSON.parse(out[1] ?? "")).toEqual({ result: {}, jsonrpc: "2.0", id: 2 });
  });
}
