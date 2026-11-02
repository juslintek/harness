import { z } from "zod";

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
  body: string;
  createdAt: number;
  editedAt: number | null;
  replyCount: number;
  mentions: string[];
  taskIds: string[];
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
  before?: number | undefined;
  thread?: string | undefined;
  limit?: number | undefined;
}
export const messagesQuery: z.ZodType<MessagesQuery> = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    thread: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
