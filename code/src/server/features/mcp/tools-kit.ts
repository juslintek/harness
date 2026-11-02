import type { Database } from "bun:sqlite";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BoardError } from "../board/api";
import { ChatError } from "../chat/api";
import { getMember } from "../orgs/api";
import type { RunIdentity, TokenScope } from "./tokens";

export interface ToolEnv {
  db: Database;
  identity: RunIdentity;
  harnessHome: string;
}

export interface ToolCtx {
  harnessHome: string;
  db: Database;
  runId: string;
  memberId: string;
  orgId: string;
}

// Raised for refusals the agent should read; unknown errors are logged and reported generically.
class ToolError extends Error {}

export function fail(message: string): never {
  throw new ToolError(message);
}

type Reply = { isError?: true; content: { type: "text"; text: string }[] };
const reply = (text: string, isError?: true): Reply => ({
  ...(isError ? { isError } : {}),
  content: [{ type: "text", text }],
});

// Every tool needs a member-bound token with the tool's scope; the member always comes from the
// token, never from tool input.
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  spec: { name: string; scope: TokenScope; description: string; shape: S },
  run: (ctx: ToolCtx, args: z.infer<z.ZodObject<S>>) => unknown,
): void {
  const { identity, db, harnessHome } = env;
  server.registerTool(spec.name, { description: spec.description, inputSchema: spec.shape }, ((
    args: z.infer<z.ZodObject<S>>,
  ): Reply => {
    if (!identity.scopes.includes(spec.scope))
      return reply(`token lacks ${spec.scope} scope`, true);
    if (identity.memberId === null || identity.orgId === null) {
      return reply("token has no member", true);
    }
    try {
      const ctx = {
        db,
        harnessHome,
        runId: identity.runId,
        memberId: identity.memberId,
        orgId: identity.orgId,
      };
      const out = run(ctx, args);
      return reply(typeof out === "string" ? out : JSON.stringify(out));
    } catch (err) {
      if (err instanceof ToolError || err instanceof ChatError || err instanceof BoardError) {
        return reply(err.message, true);
      }
      console.error(`mcp tool ${spec.name} failed`, err);
      return reply("internal error", true);
    }
    // The SDK's callback type is conditional on the shape, which TypeScript cannot resolve for a generic S.
  }) as unknown as ToolCallback<S>);
}

export function handleOf(db: Database, memberId: string | null): string | null {
  return memberId === null ? null : (getMember(db, memberId)?.handle ?? null);
}
