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
