import { mcpHandler, mintRunToken } from "../src/server/features/mcp/api";
import { registerApprovalTools } from "../src/server/features/mcp/tools-approvals";
import { registerBoardTools } from "../src/server/features/mcp/tools-board";
import { registerChatTools } from "../src/server/features/mcp/tools-chat";
import { registerHiringTools } from "../src/server/features/mcp/tools-hiring";
import type { ToolEnv } from "../src/server/features/mcp/tools-kit";
import { registerLessonTools } from "../src/server/features/mcp/tools-lessons";
import { registerManagerTools } from "../src/server/features/mcp/tools-manager";
import { registerMemoryTools } from "../src/server/features/mcp/tools-memory";
import { registerPoliciesTools } from "../src/server/features/mcp/tools-policies";
import { registerProfilesTools } from "../src/server/features/mcp/tools-profiles";
import { registerTrackingTools } from "../src/server/features/mcp/tools-tracking";
import { bootApi } from "../src/server/test-support/api-kit";
import { byText, pretty } from "./contract-lib";

const TOOL_REGISTRARS = [
  registerApprovalTools,
  registerBoardTools,
  registerChatTools,
  registerHiringTools,
  registerLessonTools,
  registerManagerTools,
  registerMemoryTools,
  registerPoliciesTools,
  registerProfilesTools,
  registerTrackingTools,
];

// Each tool checks its scope first thing, so calling the callback with a scope-less identity
// makes it name the scope it needs, without any tool input.
async function toolScopes(): Promise<Map<string, string>> {
  const scopes = new Map<string, string>();
  const env = {
    db: bootApi().db,
    harnessHome: "/unused",
    tracking: {},
    identity: { runId: "r", scopes: [], memberId: "m", orgId: "o", candidateId: null },
  } as unknown as ToolEnv;
  for (const register of TOOL_REGISTRARS) {
    const server = {
      registerTool: (name: string, _config: unknown, run: (args: object) => Promise<unknown>) => {
        const pending = run({}).then((result) => {
          const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
          const scope = /^token lacks (\w+) scope$/.exec(text)?.[1];
          if (!scope) throw new Error(`tool ${name} did not report a scope: ${text}`);
          scopes.set(name, scope);
        });
        pendings.push(pending);
      },
    };
    const pendings: Promise<void>[] = [];
    register(server as never, env);
    await Promise.all(pendings);
  }
  return scopes;
}

async function listTools(): Promise<{
  tools: { name: string; description?: string; inputSchema: unknown }[];
}> {
  const kit = bootApi();
  const token = mintRunToken(kit.db, "dump-run", ["report"]);
  const handler = mcpHandler(
    kit.db,
    { onReport: () => {}, harnessHome: "/unused", tracking: {} as never },
    1,
  );
  const res = await handler(
    new Request("http://127.0.0.1:1/", {
      method: "POST",
      headers: {
        host: "127.0.0.1:1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const body = (await res.json()) as { result: Awaited<ReturnType<typeof listTools>> };
  return body.result;
}

export async function mcpTools(): Promise<string> {
  const [{ tools }, scopes] = await Promise.all([listTools(), toolScopes()]);
  const inline: Record<string, string | null> = { whoami: null, report: "report" };
  return pretty(
    tools
      .map((tool) => {
        const scope = tool.name in inline ? inline[tool.name] : scopes.get(tool.name);
        if (scope === undefined) throw new Error(`no scope known for MCP tool ${tool.name}`);
        return { ...tool, scope };
      })
      .sort((a, b) => byText(a.name, b.name)),
  );
}
