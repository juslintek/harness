import { useEffect, useState } from "preact/hooks";
import {
  type ChannelView,
  type ChatMember,
  type ChatOrgView,
  channelListSchema,
  chatMembersSchema,
  chatOrgSchema,
  type MessageView,
  messageListSchema,
} from "../../../shared/chat";
import { api, type Loaded, useLoad, useTopic } from "../../api";
import { routeParts } from "../../route";
import { ignored } from "../auth/me";

export interface ChatData {
  org: Loaded<ChatOrgView>;
  channels: Loaded<ChannelView[]>;
  channelMembers: ChatMember[];
  messages: Loaded<MessageView[]>;
  active: ChannelView | null;
  thread: MessageView | null;
  setThread: (m: MessageView | null) => void;
  threadNudge: number;
}

const markRead = (channelId: string): Promise<unknown> =>
  api(`/api/channels/${channelId}/read`, ignored, { method: "POST" }).catch((err: unknown) =>
    console.error("cannot mark the channel read", err),
  );

function pickActive(channels: ChannelView[] | null): ChannelView | null {
  const wanted = routeParts()[3];
  return (
    channels?.find((c) => c.id === wanted) ??
    channels?.find((c) => c.kind === "org") ??
    channels?.[0] ??
    null
  );
}

export function useChatData(slug: string, orgId: string): ChatData {
  const org = useLoad(() => api(`/api/orgs/${slug}`, chatOrgSchema), [slug]);
  const channels = useLoad(() => api(`/api/orgs/${slug}/channels`, channelListSchema), [slug]);
  const active = pickActive(channels.data);
  const messages = useLoad(
    () =>
      active ? api(`/api/channels/${active.id}/messages`, messageListSchema) : Promise.resolve([]),
    [active?.id],
  );
  const channelMembers = useLoad(
    () =>
      active ? api(`/api/channels/${active.id}/members`, chatMembersSchema) : Promise.resolve([]),
    [active?.id],
  );
  const [thread, setThread] = useState<MessageView | null>(null);
  const [threadNudge, setThreadNudge] = useState(0);

  useEffect(() => setThread(null), [active?.id]);
  useEffect(() => {
    if (active) markRead(active.id).then(channels.reload);
  }, [active?.id]);
  // A null message means the socket just (re)opened, so everything may be stale.
  useTopic(`org:${orgId}`, (m) => {
    if (m && m.type !== "chat") return;
    if (!m || m.channelId === active?.id) messages.reload();
    if (m && thread && m.threadRootId === thread.id) setThreadNudge((n) => n + 1);
    if (m && m.channelId === active?.id) markRead(m.channelId).then(channels.reload);
    else channels.reload();
  });
  return {
    org,
    channels,
    channelMembers: channelMembers.data ?? [],
    messages,
    active,
    thread,
    setThread,
    threadNudge,
  };
}
