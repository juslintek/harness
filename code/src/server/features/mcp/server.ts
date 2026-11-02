import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type RunIdentity, verify } from "./tokens";

const MAX_REPORT_CHARS = 4000;

function buildServer(
  identity: RunIdentity,
  onReport: (runId: string, text: string) => void,
): McpServer {
  const server = new McpServer({ name: "harness", version: "1.0.0" });
  server.registerTool("whoami", { description: "Identify the run this token belongs to" }, () => ({
    content: [{ type: "text", text: JSON.stringify(identity) }],
  }));
  server.registerTool(
    "report",
    {
      description: "Send a progress note to the manager",
      inputSchema: { text: z.string().max(MAX_REPORT_CHARS) },
    },
    ({ text }) => {
      if (!identity.scopes.includes("report")) {
        return { isError: true, content: [{ type: "text", text: "token lacks report scope" }] };
      }
      onReport(identity.runId, text);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  return server;
}

function bearer(req: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function createHandler(
  db: Database,
  onReport: (runId: string, text: string) => void,
  port: number,
): (req: Request) => Promise<Response> {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return async (req) => {
    if (!allowedHosts.includes(req.headers.get("host") ?? "")) {
      return new Response("forbidden host", { status: 403 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    const token = bearer(req);
    const identity = token ? verify(db, token) : null;
    if (!identity) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    // No sessionIdGenerator means stateless: one fresh server and transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildServer(identity, onReport);
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  };
}
