import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChannelView } from "../../../shared/chat";
import { listChannels, listMessages, markRead, openDm, postMessage } from "../chat/api";
import { findMemberByHandle, getMember, roleAtLeast } from "../orgs/api";
import { defineTool, fail, handleOf, type ToolCtx, type ToolEnv } from "./tools-kit";

const body = z.string().min(1).max(8000);

function channel(ctx: ToolCtx, ref: string): ChannelView {
  const all = listChannels(ctx.db, ctx.memberId);
  const byId = all.find((c) => c.id === ref);
  if (byId) return byId;
  const named = all.filter((c) => c.name.toLowerCase() === ref.replace(/^#/, "").toLowerCase());
  if (named.length > 1) fail(`several channels are named ${ref}, use the id`);
  return named[0] ?? fail(`channel not found: ${ref}`);
}

function registerReads(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "chat_channels",
      scope: "chat",
      description: "List the channels you can use",
      shape: {},
    },
    (ctx) =>
      listChannels(ctx.db, ctx.memberId).map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        unread: c.unread,
      })),
  );
  defineTool(
    server,
    env,
    {
      name: "chat_read",
      scope: "chat",
      description: "Read recent messages of a channel or thread and mark it read",
      shape: {
        channel: z.string(),
        thread: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (ctx, a) => {
      const c = channel(ctx, a.channel);
      const messages = listMessages(ctx.db, c.id, ctx.memberId, {
        ...(a.thread === undefined ? {} : { threadRootId: a.thread }),
        ...(a.limit === undefined ? {} : { limit: a.limit }),
      });
      markRead(ctx.db, c.id, ctx.memberId);
      return messages.map((m) => ({
        id: m.id,
        author: handleOf(ctx.db, m.authorId),
        body: m.body,
        created_at: m.createdAt,
        replyCount: m.replyCount,
      }));
    },
  );
}

function registerWrites(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    {
      name: "chat_post",
      scope: "chat",
      description: "Post a message; @handle mentions a member and #12 links a task",
      shape: { channel: z.string(), body, thread: z.string().optional() },
    },
    (ctx, a) => {
      const m = postMessage(ctx.db, {
        channelId: channel(ctx, a.channel).id,
        authorId: ctx.memberId,
        body: a.body,
        ...(a.thread === undefined ? {} : { threadRootId: a.thread }),
      });
      return { id: m.id };
    },
  );
  defineTool(
    server,
    env,
    {
      name: "chat_dm",
      scope: "chat",
      description: "Send a direct message to a member of your org",
      shape: { handle: z.string(), body },
    },
    (ctx, a) => {
      const self = getMember(ctx.db, ctx.memberId);
      if (!self || !roleAtLeast(self.role, "member")) fail("viewers cannot send direct messages");
      const to = findMemberByHandle(ctx.db, ctx.orgId, a.handle.replace(/^@/, ""));
      if (!to) fail(`no member @${a.handle}`);
      const m = postMessage(ctx.db, {
        channelId: openDm(ctx.db, ctx.memberId, to.id).id,
        authorId: ctx.memberId,
        body: a.body,
      });
      return { id: m.id };
    },
  );
}

export function registerChatTools(server: McpServer, env: ToolEnv): void {
  registerReads(server, env);
  registerWrites(server, env);
}
