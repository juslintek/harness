import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { HarnessToolName } from "../../../shared/harness-tools";
import { getMember, listPositions } from "../orgs/api";
import { type RunIdentity, verify } from "./tokens";
import { registerApprovalTools } from "./tools-approvals";
import { registerBoardTools } from "./tools-board";
import { registerChatTools } from "./tools-chat";
import { registerHiringTools } from "./tools-hiring";
import type { TrackingPort } from "./tools-kit";
import { registerManagerTools } from "./tools-manager";
import { registerMemoryTools } from "./tools-memory";
import { registerPoliciesTools } from "./tools-policies";
import { registerProfilesTools } from "./tools-profiles";
import { registerTrackingTools } from "./tools-tracking";

const MAX_REPORT_CHARS = 4000;

export interface McpDeps {
  onReport: (runId: string, text: string) => void;
  harnessHome: string;
  tracking: TrackingPort;
}

function whoami(db: Database, identity: RunIdentity): unknown {
  const member = identity.memberId === null ? null : getMember(db, identity.memberId);
  if (!member) return { runId: identity.runId, scopes: identity.scopes };
  return {
    runId: identity.runId,
    scopes: identity.scopes,
    member: {
      id: member.id,
      handle: member.handle,
      orgId: member.orgId,
      role: member.role,
      positions: listPositions(db, member.orgId)
        .filter((p) => p.memberId === member.id)
        .map((p) => ({ title: p.title, isManager: p.isManager })),
    },
  };
}

function buildServer(db: Database, identity: RunIdentity, deps: McpDeps): McpServer {
  const server = new McpServer({ name: "harness", version: "1.0.0" });
  const env = { db, identity, harnessHome: deps.harnessHome, tracking: deps.tracking };
  const whoamiName: HarnessToolName = "whoami";
  server.registerTool(
    whoamiName,
    { description: "Identify the run and member this token belongs to" },
    () => ({
      content: [{ type: "text", text: JSON.stringify(whoami(db, identity)) }],
    }),
  );
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
      deps.onReport(identity.runId, text);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  registerBoardTools(server, env);
  registerChatTools(server, env);
  registerApprovalTools(server, env);
  registerProfilesTools(server, env);
  registerHiringTools(server, env);
  registerPoliciesTools(server, env);
  registerTrackingTools(server, env);
  registerManagerTools(server, env);
  registerMemoryTools(server, env);
  return server;
}

function bearer(req: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function createHandler(
  db: Database,
  deps: McpDeps,
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
    const server = buildServer(db, identity, deps);
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  };
}
