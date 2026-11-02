import type { Database } from "bun:sqlite";
import { type ChannelView, type MessageView, messageBodySchema } from "../../../shared/chat";
import {
  findMembersByHandle,
  getMember,
  getProject,
  listMembers,
  type MemberRow,
  onOrgCreated,
  projectAccess,
} from "../orgs/api";
import { parseMessage } from "./parse";
import {
  addChannelMembers,
  candidateChannels,
  channelMemberIds,
  ensureScopedChannel,
  findDm,
  getChannel,
  getMessage,
  insertChannel,
  insertMessage,
  isChannelMember,
  type MessageQuery,
  queryMessages,
  resolveTaskIds,
  setLastRead,
  unreadCount,
} from "./repo";

export type { ChannelView, MessageView } from "../../../shared/chat";
export { channelMemberIds, getChannel, parseMessage };

export class ChatError extends Error {
  readonly code: "not_found" | "forbidden" | "invalid";
  constructor(code: "not_found" | "forbidden" | "invalid", message: string) {
    super(message);
    this.code = code;
  }
}

export interface ChatEvent {
  message: MessageView;
  mentions: string[];
  channel: ChannelView;
}

const listeners = new Set<(event: ChatEvent) => void>();

export function onMessage(fn: (event: ChatEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function ensureOrgChannel(db: Database, orgId: string): ChannelView {
  return ensureScopedChannel(db, { orgId, kind: "org", name: "general" });
}

export function ensureTeamChannel(db: Database, teamId: string): ChannelView {
  // teams has no lookup in the orgs api and a channel only needs its org and name.
  const team = db
    .query<{ org_id: string; name: string }, [string]>(
      "SELECT org_id, name FROM teams WHERE id = ?",
    )
    .get(teamId);
  if (!team) throw new ChatError("not_found", "team not found");
  return ensureScopedChannel(db, { orgId: team.org_id, kind: "team", name: team.name, teamId });
}

export function ensureProjectChannel(db: Database, projectId: string): ChannelView {
  const project = getProject(db, projectId);
  if (!project) throw new ChatError("not_found", "project not found");
  return ensureScopedChannel(db, {
    orgId: project.orgId,
    kind: "project",
    name: project.name,
    projectId,
  });
}

function ids(db: Database, table: string, orgId?: string): string[] {
  const where = orgId === undefined ? "" : " WHERE org_id = ?";
  return db
    .query<{ id: string }, string[]>(`SELECT id FROM ${table}${where}`)
    .all(...(orgId === undefined ? [] : [orgId]))
    .map((r) => r.id);
}

// Orgs, teams and projects that exist before this slice is wired (or were made while it was
// not) get their channels on boot; ensure* is idempotent so repeated wiring is harmless.
export function wireChat(db: Database): void {
  for (const id of ids(db, "orgs")) ensureOrgChannel(db, id);
  for (const id of ids(db, "teams")) ensureTeamChannel(db, id);
  for (const id of ids(db, "projects")) ensureProjectChannel(db, id);
  onOrgCreated((eventDb, org) => {
    ensureOrgChannel(eventDb, org.id);
    for (const id of ids(eventDb, "teams", org.id)) {
      ensureTeamChannel(eventDb, id);
    }
  });
}

export function channelAccess(
  db: Database,
  memberId: string,
  channelId: string,
): "none" | "read" | "write" {
  const channel = getChannel(db, channelId);
  const member = getMember(db, memberId);
  if (!channel || !member) return "none";
  if (channel.kind === "org" || channel.kind === "team") {
    if (member.orgId !== channel.orgId) return "none";
    return member.role === "viewer" ? "read" : "write";
  }
  if (channel.kind === "project") {
    const access = projectAccess(db, { memberId }, channel.projectId as string);
    if (access === "none") return "none";
    return access === "read" ? "read" : "write";
  }
  return isChannelMember(db, channelId, memberId) ? "write" : "none";
}

// Mentions only resolve inside the channel's own org, so a project channel lists its org's members
// who can reach the project rather than members of grantee orgs.
export function channelMembers(db: Database, channel: ChannelView): MemberRow[] {
  return listMembers(db, channel.orgId).filter(
    (m) => channelAccess(db, m.id, channel.id) !== "none",
  );
}

function requireMember(db: Database, memberId: string, orgId: string): void {
  const member = getMember(db, memberId);
  if (!member || member.orgId !== orgId) throw new ChatError("invalid", "member not in org");
}

export function createGroup(
  db: Database,
  orgId: string,
  name: string,
  memberIds: string[],
  by: string,
): ChannelView {
  const title = name.trim();
  if (title.length < 1 || title.length > 80) throw new ChatError("invalid", "bad group name");
  const everyone = [...new Set([by, ...memberIds])];
  for (const id of everyone) requireMember(db, id, orgId);
  return db.transaction(() => {
    const channel = insertChannel(db, { orgId, kind: "group", name: title });
    addChannelMembers(db, channel.id, everyone);
    return channel;
  })();
}

export function openDm(db: Database, a: string, b: string): ChannelView {
  const first = getMember(db, a);
  const second = getMember(db, b);
  if (!first || !second || a === b) throw new ChatError("invalid", "dm needs two members");
  if (first.orgId !== second.orgId) throw new ChatError("invalid", "members in different orgs");
  const dmKey = [a, b].sort().join(":");
  const existing = findDm(db, dmKey);
  if (existing) return existing;
  return db.transaction(() => {
    const channel = insertChannel(db, {
      orgId: first.orgId,
      kind: "dm",
      name: `${first.handle}, ${second.handle}`,
      dmKey,
    });
    addChannelMembers(db, channel.id, [a, b]);
    return channel;
  })();
}

export function listChannels(db: Database, memberId: string): ChannelView[] {
  const member = getMember(db, memberId);
  if (!member) return [];
  return candidateChannels(db, memberId, member.orgId)
    .filter((c) => channelAccess(db, memberId, c.id) !== "none")
    .map((c) => ({ ...c, unread: unreadCount(db, c.id, memberId) }));
}

export interface PostInput {
  channelId: string;
  authorId: string;
  body: string;
  threadRootId?: string;
}

function checkThreadRoot(db: Database, channelId: string, rootId: string): void {
  const root = getMessage(db, rootId);
  if (!root || root.channelId !== channelId) throw new ChatError("invalid", "bad thread root");
  if (root.threadRootId !== null) throw new ChatError("invalid", "cannot reply to a reply");
}

export function postMessage(db: Database, input: PostInput): MessageView {
  if (!messageBodySchema.safeParse(input.body).success) {
    throw new ChatError("invalid", "body must be 1 to 8000 characters");
  }
  const channel = getChannel(db, input.channelId);
  if (!channel) throw new ChatError("not_found", "channel not found");
  if (channelAccess(db, input.authorId, channel.id) !== "write") {
    throw new ChatError("forbidden", "no write access");
  }
  if (input.threadRootId !== undefined) checkThreadRoot(db, channel.id, input.threadRootId);
  const parsed = parseMessage(input.body);
  const mentions = parsed.handles.flatMap((handle) => {
    // A project channel is open to grantee-org members, so the same handle can match two people.
    const open = findMembersByHandle(db, handle).filter(
      (m) => channelAccess(db, m.id, channel.id) !== "none",
    );
    return open.length === 1 && open[0] ? [open[0].id] : [];
  });
  const message = insertMessage(db, {
    channelId: channel.id,
    authorId: input.authorId,
    body: input.body,
    threadRootId: input.threadRootId ?? null,
    mentions,
    taskIds: resolveTaskIds(db, channel.orgId, parsed.taskNumbers),
  });
  for (const fn of listeners) {
    try {
      fn({ message, mentions, channel });
    } catch (err) {
      console.error("chat listener failed", err);
    }
  }
  return message;
}

export function listMessages(db: Database, channelId: string, opts: MessageQuery): MessageView[] {
  return queryMessages(db, channelId, opts);
}

export function markRead(db: Database, channelId: string, memberId: string): void {
  if (channelAccess(db, memberId, channelId) === "none") {
    throw new ChatError("forbidden", "no access");
  }
  setLastRead(db, channelId, memberId);
}
