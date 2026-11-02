import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import {
  type ChannelView,
  dmBody,
  groupBody,
  messagesQuery,
  postMessageBody,
} from "../../../shared/chat";
import { defined, forbidden, notFound, parseBody, parseQuery, routeError } from "../../route-kit";
import type { AuthEnv } from "../auth/api";
import {
  getOrgBySlug,
  type MemberRow,
  memberForUser,
  projectMember,
  roleAtLeast,
} from "../orgs/api";
import {
  ChatError,
  channelAccess,
  channelMembers,
  createGroup,
  getChannel,
  listChannels,
  listMessages,
  markRead,
  openDm,
  postMessage,
} from "./api";

const CHAT_STATUS = { not_found: 404, forbidden: 403, invalid: 400 } as const;

function chatError(err: Error, c: Context): Response {
  if (!(err instanceof ChatError)) return routeError(err, c);
  return c.json({ error: err.code, message: err.message }, CHAT_STATUS[err.code]);
}

function orgMember(db: Database, c: Context<AuthEnv>): MemberRow | null {
  const org = getOrgBySlug(db, c.req.param("org") ?? "");
  return org ? memberForUser(db, org.id, c.get("actor").userId) : null;
}

// Project channels are open to grantee orgs, so the acting member is whichever one has project access.
function channelMember(db: Database, userId: string, channel: ChannelView): MemberRow | null {
  if (channel.projectId) return projectMember(db, userId, channel.projectId)?.member ?? null;
  return memberForUser(db, channel.orgId, userId);
}

// channelAccess decides everything: none is a 404 so channel ids do not leak, read-only gets 403 on writes.
function channelScope(
  db: Database,
  c: Context<AuthEnv>,
  need: "read" | "write",
): { channel: ChannelView; member: MemberRow } | Response {
  const channel = getChannel(db, c.req.param("id") ?? "");
  const member = channel ? channelMember(db, c.get("actor").userId, channel) : null;
  if (!channel || !member) return notFound(c);
  const access = channelAccess(db, member.id, channel.id);
  if (access === "none") return notFound(c);
  return need === "write" && access === "read" ? forbidden(c) : { channel, member };
}

function orgChatRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/orgs/:org/channels", (c) => {
    const member = orgMember(db, c);
    return member ? c.json(listChannels(db, member.id)) : notFound(c);
  });
  app.post("/orgs/:org/groups", async (c) => {
    const member = orgMember(db, c);
    if (!member) return notFound(c);
    if (!roleAtLeast(member.role, "member")) return forbidden(c);
    const body = await parseBody(c, groupBody);
    if (body instanceof Response) return body;
    return c.json(createGroup(db, member.orgId, body.name, body.memberIds, member.id), 201);
  });
  app.post("/orgs/:org/dms", async (c) => {
    const member = orgMember(db, c);
    if (!member) return notFound(c);
    if (!roleAtLeast(member.role, "member")) return forbidden(c);
    const body = await parseBody(c, dmBody);
    if (body instanceof Response) return body;
    return c.json(openDm(db, member.id, body.memberId));
  });
}

function messageRoutes(db: Database, app: Hono<AuthEnv>): void {
  app.get("/channels/:id/messages", (c) => {
    const found = channelScope(db, c, "read");
    if (found instanceof Response) return found;
    const query = parseQuery(c, messagesQuery);
    if (query instanceof Response) return query;
    const { thread, ...rest } = query;
    return c.json(listMessages(db, found.channel.id, defined({ ...rest, threadRootId: thread })));
  });
  app.post("/channels/:id/messages", async (c) => {
    const found = channelScope(db, c, "write");
    if (found instanceof Response) return found;
    const body = await parseBody(c, postMessageBody);
    if (body instanceof Response) return body;
    const input = { ...defined(body), channelId: found.channel.id, authorId: found.member.id };
    return c.json(postMessage(db, input), 201);
  });
  app.get("/channels/:id/members", (c) => {
    const found = channelScope(db, c, "read");
    if (found instanceof Response) return found;
    const members = channelMembers(db, found.channel).map((m) => ({
      id: m.id,
      kind: m.kind,
      handle: m.handle,
      displayName: m.displayName,
    }));
    return c.json(members);
  });
  app.post("/channels/:id/read", (c) => {
    const found = channelScope(db, c, "read");
    if (found instanceof Response) return found;
    markRead(db, found.channel.id, found.member.id);
    return c.json({ ok: true });
  });
}

export function chatRoutes(db: Database): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.onError(chatError);
  orgChatRoutes(db, app);
  messageRoutes(db, app);
  return app;
}
