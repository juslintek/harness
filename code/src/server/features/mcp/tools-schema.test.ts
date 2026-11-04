import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { mcpHandler, mintRunToken } from "./api";
import { trackingPort } from "./test-kit";

let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const token = mintRunToken(db, "run-1", ["report"]);
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      mcpHandler(
        db,
        { onReport: () => {}, harnessHome: "/h", tracking: trackingPort },
        server.port as number,
      )(req),
  });
  (server as unknown as { token: string }).token = token;
});
afterEach(() => server.stop(true));

// Codex drops a whole tool when any of its schema nodes has one of these shapes.
function keyword(k: string, v: unknown): string | null {
  if (k === "items" && Array.isArray(v)) return "items is an array";
  if (k === "type" && typeof v !== "string") return "type is not a string";
  if (k === "additionalItems" || k === "prefixItems") return `${k} is present`;
  return null;
}

function bad(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => bad(n, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([k, v]) => {
    // keys of a "properties" map are field names (a field may be called "type"), not keywords
    if (k === "properties" && v !== null && typeof v === "object")
      return Object.entries(v).flatMap(([name, sub]) => bad(sub, `${path}.${k}.${name}`));
    const problem = keyword(k, v);
    return [...(problem === null ? [] : [`${path}.${k}: ${problem}`]), ...bad(v, `${path}.${k}`)];
  });
}

test("every tool input schema is parseable by codex", async () => {
  const token = (server as unknown as { token: string }).token;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  expect(tools.length).toBeGreaterThan(5);
  const problems = tools.flatMap((t) => bad(t.inputSchema, t.name));
  expect(problems).toEqual([]);
});
