import { z } from "zod";
import { type PersonRef, personRefSchema } from "./people";

export const messageBodySchema: z.ZodString = z.string().min(1).max(8000);

export type ChannelKind = "org" | "team" | "project" | "group" | "dm";

export interface ChannelView {
  id: string;
  orgId: string;
  kind: ChannelKind;
  name: string;
  teamId: string | null;
  projectId: string | null;
  createdAt: number;
  unread: number;
}

export interface MessageView {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorId: string | null;
  author: PersonRef | null;
  body: string;
  createdAt: number;
  editedAt: number | null;
  replyCount: number;
  mentions: string[];
  taskIds: string[];
  tasks: { number: number; projectId: string }[];
}

const id = z.string().min(1).max(64);

export interface GroupBody {
  name: string;
  memberIds: string[];
}
export const groupBody: z.ZodType<GroupBody> = z
  .object({ name: z.string().trim().min(1).max(80), memberIds: z.array(id).max(200) })
  .strict();

export interface DmBody {
  memberId: string;
}
export const dmBody: z.ZodType<DmBody> = z.object({ memberId: id }).strict();

export interface PostMessageBody {
  body: string;
  threadRootId?: string | undefined;
}
export const postMessageBody: z.ZodType<PostMessageBody> = z
  .object({ body: messageBodySchema, threadRootId: id.optional() })
  .strict();

export interface MessagesQuery {
  before?: string | undefined;
  thread?: string | undefined;
  limit?: number | undefined;
}
export const messagesQuery: z.ZodType<MessagesQuery> = z
  .object({
    // `<createdAt>` or `<createdAt>:<id>`; the id breaks ties between messages made in one millisecond.
    before: z
      .string()
      .regex(/^[1-9]\d{0,15}(:[\w-]{1,64})?$/)
      .optional(),
    thread: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const channelKind = z.enum(["org", "team", "project", "group", "dm"]);
export const channelViewSchema: z.ZodType<ChannelView> = z.object({
  id: z.string(),
  orgId: z.string(),
  kind: channelKind,
  name: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.number(),
  unread: z.number(),
});
export const channelListSchema: z.ZodType<ChannelView[]> = z.array(channelViewSchema);

export const messageViewSchema: z.ZodType<MessageView> = z.object({
  id: z.string(),
  channelId: z.string(),
  threadRootId: z.string().nullable(),
  authorId: z.string().nullable(),
  author: personRefSchema.nullable(),
  body: z.string(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  replyCount: z.number(),
  mentions: z.array(z.string()),
  taskIds: z.array(z.string()),
  tasks: z.array(z.object({ number: z.number(), projectId: z.string() })),
});
export const messageListSchema: z.ZodType<MessageView[]> = z.array(messageViewSchema);

export interface ChatMember {
  id: string;
  kind: "human" | "agent";
  handle: string;
  displayName: string;
  // Set only when another listed member has the same handle, so the picker can tell them apart.
  orgName?: string | undefined;
}
export const chatMembersSchema: z.ZodType<ChatMember[]> = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(["human", "agent"]),
    handle: z.string(),
    displayName: z.string(),
    orgName: z.string().optional(),
  }),
);

export interface ChatOrgView {
  me: { id: string; handle: string };
  members: ChatMember[];
}
export const chatOrgSchema: z.ZodType<ChatOrgView> = z.object({
  me: z.object({ id: z.string(), handle: z.string() }),
  members: chatMembersSchema,
});
