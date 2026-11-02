import { useMemo, useState } from "preact/hooks";
import { type ChatMember, messageViewSchema } from "../../../shared/chat";
import { api } from "../../api";
import { me } from "../auth/me";
import { ChannelDialog, type DialogKind } from "./channel-dialogs";
import { ChannelList, channelLabel } from "./channel-list";
import { type ChatData, useChatData } from "./chat-data";
import { Composer } from "./composer";
import { type MessageContext, MessageList } from "./message-list";
import { ThreadPanel } from "./thread-panel";

function useMessageContext(slug: string, data: ChatData): MessageContext {
  const members = data.org.data?.members ?? [];
  return useMemo(
    () => ({
      slug,
      byId: new Map(members.map((m) => [m.id, m])),
      byHandle: new Map(members.map((m) => [m.handle, m])),
    }),
    [slug, data.org.data],
  );
}

function ChatView({ slug, orgId }: { slug: string; orgId: string }): preact.JSX.Element {
  const data = useChatData(slug, orgId);
  const ctx = useMessageContext(slug, data);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const { org, channels, messages, active, thread } = data;
  if (!org.data || !channels.data) {
    return <p class="muted">{org.error ?? channels.error ?? "Loading…"}</p>;
  }
  const myHandle = org.data.me.handle;
  const orgOthers: ChatMember[] = org.data.members.filter((m) => m.id !== org.data?.me.id);
  const others: ChatMember[] = data.channelMembers.filter((m) => m.id !== org.data?.me.id);
  const send = async (body: string): Promise<void> => {
    if (!active) return;
    await api(`/api/channels/${active.id}/messages`, messageViewSchema, {
      method: "POST",
      body: { body },
    });
    messages.reload();
  };
  return (
    <div class="chat" data-thread={thread ? "open" : "closed"}>
      <ChannelList
        channels={channels.data}
        activeId={active?.id ?? null}
        slug={slug}
        myHandle={myHandle}
        onNewGroup={() => setDialog("group")}
        onNewDm={() => setDialog("dm")}
      />
      <section class="pane" aria-label="Conversation">
        <h2>{active ? channelLabel(active, myHandle) : "No channel"}</h2>
        {messages.error && (
          <p class="error" role="alert">
            {messages.error}
          </p>
        )}
        <MessageList messages={messages.data ?? []} ctx={ctx} onOpenThread={data.setThread} />
        {active && <Composer key={active.id} members={others} label="Message" onSend={send} />}
      </section>
      {thread && (
        <ThreadPanel
          key={thread.id}
          root={thread}
          ctx={ctx}
          members={others}
          refresh={data.threadNudge}
          onClose={() => data.setThread(null)}
          onPosted={messages.reload}
        />
      )}
      {dialog && (
        <ChannelDialog
          kind={dialog}
          slug={slug}
          members={orgOthers}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null);
            location.hash = `#/o/${slug}/chat/${c.id}`;
            channels.reload();
          }}
        />
      )}
    </div>
  );
}

export function ChatPage({ slug }: { slug: string }): preact.JSX.Element {
  if (me.value === null) return <p class="muted">Loading…</p>;
  const org = me.value.orgs.find((o) => o.slug === slug);
  if (!org) return <p class="muted">Org not found</p>;
  return <ChatView key={slug} slug={slug} orgId={org.id} />;
}
