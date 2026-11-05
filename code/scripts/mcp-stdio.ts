import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/server/config";
import { getSecret } from "../src/server/features/agents/api";

// Claude Desktop starts this as a stdio MCP server. It forwards tools/list and tools/call to the
// instance's /mcp/remote with the long-lived token the link stored in secrets.json.

function fail(message: string): never {
  console.error(`harness mcp link: ${message}`);
  process.exit(1);
}

function homeArg(argv: string[]): string {
  const at = argv.indexOf("--home");
  const home = at === -1 ? undefined : argv[at + 1];
  return home ?? fail("usage: mcp-stdio.ts --home <harness home>");
}

function connectTarget(home: string): { url: URL; token: string } {
  const token = getSecret("desktop.token", home);
  if (!token) fail("not linked: no desktop token in secrets.json. Link again from Harness.");
  const config = loadConfig({ ...process.env, HARNESS_HOME: home });
  return { url: new URL("/mcp/remote", config.rp.origin), token };
}

function unauthorized(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

async function main(): Promise<void> {
  const { url, token } = connectTarget(homeArg(process.argv.slice(2)));
  const upstream = new Client({ name: "harness-stdio-proxy", version: "1" });
  let ready: Promise<void> | undefined;
  // Connected on first use, so Claude Desktop's startup handshake never waits on the network.
  const connected = (): Promise<void> => {
    ready ??= upstream.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return ready;
  };
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      await connected();
      return await run();
    } catch (error) {
      if (unauthorized(error)) fail("the token was rejected (revoked or expired). Link again.");
      throw error;
    }
  };

  const server = new Server({ name: "harness", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => guarded(() => upstream.listTools()));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    guarded(() => upstream.callTool(request.params) as Promise<CallToolResult>),
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error) => fail(error instanceof Error ? error.message : "failed"));
