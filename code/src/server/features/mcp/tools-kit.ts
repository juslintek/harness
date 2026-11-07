import type { Database } from "bun:sqlite";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { HarnessToolName } from "../../../shared/harness-tools";
import type { EstimateKind } from "../../../shared/tracking";
import { DomainError } from "../../route-kit";
import { BoardError } from "../board/api";
import { ChatError } from "../chat/api";
import { getMember } from "../orgs/api";
import type { RunIdentity, TokenScope } from "./tokens";

// Tracking, routing and budgets reach the runtimes, which mint the tokens these tools run under, so
// the app hands them in instead of the tools importing them.
export interface TrackingPort {
  addEstimate: (
    db: Database,
    e: {
      taskId: string;
      kind: EstimateKind;
      minutes: number;
      source: "agent" | "human";
      byMember: string;
      rationale?: string;
    },
  ) => void;
  taskFields: (db: Database, taskId: string) => Record<string, unknown>;
  budgetState: (db: Database, memberId: string) => "ok" | "warn" | "paused";
}

// A remote (OAuth) caller is a human with no run, so runId is null there.
type ToolIdentity = Omit<RunIdentity, "runId"> & { runId: string | null };

export interface ToolEnv {
  db: Database;
  identity: ToolIdentity;
  harnessHome: string;
  tracking: TrackingPort;
}

export interface MemberCtx {
  harnessHome: string;
  db: Database;
  memberId: string;
  orgId: string;
}

export interface ToolCtx extends MemberCtx {
  runId: string;
}

export interface CandidateCtx {
  db: Database;
  runId: string;
  candidateId: string;
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

interface ToolSpec<S extends z.ZodRawShape> {
  name: HarnessToolName;
  scope: TokenScope;
  description: string;
  shape: S;
}

function register<S extends z.ZodRawShape, C>(
  server: McpServer,
  env: ToolEnv,
  spec: ToolSpec<S>,
  bind: (identity: ToolIdentity) => C | string,
  run: (ctx: C, args: z.infer<z.ZodObject<S>>) => unknown,
): void {
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.shape },
    (async (args: z.infer<z.ZodObject<S>>): Promise<Reply> => {
      if (!env.identity.scopes.includes(spec.scope))
        return reply(`token lacks ${spec.scope} scope`, true);
      const ctx = bind(env.identity);
      if (typeof ctx === "string") return reply(ctx, true);
      try {
        const out = await run(ctx, args);
        return reply(typeof out === "string" ? out : JSON.stringify(out));
      } catch (err) {
        const readable =
          err instanceof ToolError ||
          err instanceof ChatError ||
          err instanceof BoardError ||
          err instanceof DomainError;
        if (readable) return reply(err.message, true);
        console.error(`mcp tool ${spec.name} failed`, err);
        return reply("internal error", true);
      }
      // The SDK's callback type is conditional on the shape, which TypeScript cannot resolve for a generic S.
    }) as unknown as ToolCallback<S>,
  );
}

function memberCtx(env: ToolEnv, identity: ToolIdentity): MemberCtx | string {
  return identity.memberId === null || identity.orgId === null
    ? "token has no member"
    : {
        db: env.db,
        harnessHome: env.harnessHome,
        memberId: identity.memberId,
        orgId: identity.orgId,
      };
}

// Tools that never read the run (board, chat) also serve remote callers, who have none.
export function defineMemberTool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  spec: ToolSpec<S>,
  run: (ctx: MemberCtx, args: z.infer<z.ZodObject<S>>) => unknown,
): void {
  register(server, env, spec, (identity) => memberCtx(env, identity), run);
}

// Every tool needs a member-bound token with the tool's scope; the member always comes from the
// token, never from tool input.
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  spec: ToolSpec<S>,
  run: (ctx: ToolCtx, args: z.infer<z.ZodObject<S>>) => unknown,
): void {
  register(
    server,
    env,
    spec,
    (identity) => {
      const base = memberCtx(env, identity);
      if (typeof base === "string") return base;
      return identity.runId === null ? "token has no run" : { ...base, runId: identity.runId };
    },
    run,
  );
}

// An interview run's token names a candidate and no member, so these tools are the only ones it can use.
export function defineCandidateTool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  spec: Omit<ToolSpec<S>, "scope">,
  run: (ctx: CandidateCtx, args: z.infer<z.ZodObject<S>>) => unknown,
): void {
  const { db } = env;
  register(
    server,
    env,
    { ...spec, scope: "interview" },
    (identity) =>
      identity.candidateId === null || identity.orgId === null || identity.runId === null
        ? "token has no candidate"
        : { db, runId: identity.runId, candidateId: identity.candidateId, orgId: identity.orgId },
    run,
  );
}

export function handleOf(db: Database, memberId: string | null): string | null {
  return memberId === null ? null : (getMember(db, memberId)?.handle ?? null);
}
