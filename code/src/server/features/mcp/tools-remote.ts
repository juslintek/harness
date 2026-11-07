import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listChannels } from "../chat/api";
import { appendEvent } from "../logs/api";
import { type AccessIdentity, verifyAccessToken } from "../oauth/api";
import { registerBoardTools } from "./tools-board";
import { registerChatTools } from "./tools-chat";
import type { MemberCtx, ToolEnv, TrackingPort } from "./tools-kit";
import { project, task, visibleProjects } from "./tools-refs";

type RemoteScope = "board" | "chat";

// What a human collaborator in a chat app needs. Everything else the shared board and chat modules
// register (checkout, release, update, depend, dm) is omitted, and no other tool module is
// registered at all.
export const REMOTE_TOOLS: Readonly<Record<string, RemoteScope>> = {
  board_list: "board",
  task_get: "board",
  task_create: "board",
  task_move: "board",
  task_comment: "board",
  chat_channels: "chat",
  chat_read: "chat",
  chat_post: "chat",
};

export interface RemoteDeps {
  harnessHome: string;
  tracking: TrackingPort;
}

type Refusal = string | null;

function refuse(text: string): { isError: true; content: { type: "text"; text: string }[] } {
  return { isError: true, content: [{ type: "text", text }] };
}

const TASK_ARGS = ["task", "parent", "dependsOn"];

function channelRefusal(ctx: MemberCtx, ref: string, visible: Set<string>): Refusal {
  const name = ref.replace(/^#/, "").toLowerCase();
  const hit = listChannels(ctx.db, ctx.memberId).find(
    (c) => c.id === ref || c.name.toLowerCase() === name,
  );
  const inOrg = hit !== undefined && (hit.orgId === ctx.orgId || visible.has(hit.projectId ?? ""));
  return inOrg ? null : `channel not found: ${ref}`;
}

// The token's org binds the call: a task, project or channel the member could reach through another
// membership (or by guessing an id) is refused unless it sits in the token's own org view.
function orgRefusal(ctx: MemberCtx, args: Record<string, unknown>): Refusal {
  try {
    if (typeof args.project === "string") project(ctx, args.project);
    const visible = new Set(visibleProjects(ctx).map((p) => p.id));
    for (const key of TASK_ARGS) {
      const ref = args[key];
      if (typeof ref !== "string" && typeof ref !== "number") continue;
      if (!visible.has(task(ctx, ref, false).projectId)) return `task not found: ${ref}`;
    }
    return typeof args.channel === "string" ? channelRefusal(ctx, args.channel, visible) : null;
  } catch (err) {
    return err instanceof Error ? err.message : "refused";
  }
}

// Runs before every tool call, not only at connect: the token is read again, so a revoked grant,
// a narrowed scope or a removed member stops the very next call.
function callRefusal(
  db: Database,
  token: string,
  bound: AccessIdentity,
  name: string,
  args: unknown,
  harnessHome: string,
): Refusal {
  const now = verifyAccessToken(db, token);
  if (!now || now.memberId !== bound.memberId || now.orgId !== bound.orgId) {
    return "token no longer valid";
  }
  const needed = REMOTE_TOOLS[name];
  if (!needed || !now.scopes.includes(needed)) return `token lacks ${needed ?? name} scope`;
  const ctx = { db, harnessHome, memberId: now.memberId, orgId: now.orgId };
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  return orgRefusal(ctx, record);
}

function attribute(db: Database, memberId: string, name: string): void {
  appendEvent(db, {
    kind: "tool_call",
    toolName: name,
    agent: memberId,
    source: "remote_mcp",
  });
}

// Reuses the board and chat registration, but gates each registered tool: listed only when the
// token's scope allows it, and re-checked on every call.
function gate(server: McpServer, db: Database, token: string, who: AccessIdentity, home: string) {
  return new Proxy(server, {
    get(target, prop) {
      if (prop !== "registerTool") return Reflect.get(target, prop, target);
      return (name: string, config: never, cb: (...a: unknown[]) => unknown) => {
        const needed = REMOTE_TOOLS[name];
        if (!needed || !who.scopes.includes(needed)) return;
        target.registerTool(name, config, (async (...a: unknown[]) => {
          const refusal = callRefusal(db, token, who, name, a[0], home);
          if (refusal) return refuse(refusal);
          attribute(db, who.memberId, name);
          return cb(...a);
        }) as never);
      };
    },
  });
}

export function buildRemoteServer(
  db: Database,
  token: string,
  who: AccessIdentity,
  deps: RemoteDeps,
): McpServer {
  const server = new McpServer({ name: "harness", version: "1.0.0" });
  const gated = gate(server, db, token, who, deps.harnessHome);
  const scopes = who.scopes.filter((s): s is RemoteScope => s === "board" || s === "chat");
  const env: ToolEnv = {
    db,
    harnessHome: deps.harnessHome,
    tracking: {
      ...deps.tracking,
      addEstimate: (db, estimate) =>
        deps.tracking.addEstimate(db, { ...estimate, source: "human" }),
    },
    identity: {
      runId: null,
      scopes,
      memberId: who.memberId,
      orgId: who.orgId,
      candidateId: null,
    },
  };
  registerBoardTools(gated, env);
  registerChatTools(gated, env);
  return server;
}
