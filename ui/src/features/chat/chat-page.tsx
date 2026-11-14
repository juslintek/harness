import {
  type ChannelView,
  type ChatMember,
  channelListSchema,
  chatMembersSchema,
  chatOrgSchema,
  type MessageView,
  messageListSchema,
  messageViewSchema,
} from "@shared/chat";
import { createEffect, createMemo, createSignal, type JSX, on, Show } from "solid-js";
import { api } from "../../api";
import { ignored, me } from "../../auth/me";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { routeParts } from "../../route";
import { State } from "../../ui/molecules";
import { ChannelDialog, type DialogKind } from "./channel-dialog";
import { ChannelList, channelLabel } from "./channel-list";
import { Composer } from "./composer";
import "./chat.css";
import { createHistory, PAGE_SIZE } from "./history";
import { type MessageContext, MessageList } from "./messages";
import { ThreadPanel } from "./thread-panel";
import { WorkingStrip } from "./working-strip";

interface ChatEvent {
  seq: number;
  // null: the socket just (re)opened, so everything may be stale.
  channelId: string | null;
  threadRootId: string | null;
}

const markRead = (channelId: string): Promise<unknown> =>
  api(`/api/channels/${channelId}/read`, ignored, { method: "POST" }).catch((err: unknown) =>
    console.error("cannot mark the channel read", err),
  );

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function Conversation(props: {
  channel: () => ChannelView | undefined;
  channelId: string;
  ctx: MessageContext;
  myHandle: string;
  agents: Set<string>;
  event: () => ChatEvent | null;
}): JSX.Element {
  const id = props.channelId;
  const base = `/api/channels/${id}/messages`;
  const messages = createLoad(`${base}?limit=${PAGE_SIZE}`, messageListSchema);
  const members = createLoad(`/api/channels/${id}/members`, chatMembersSchema);
  const history = createHistory(
    () => messages.data()?.filter((m) => m.channelId === id && m.threadRootId === null),
    (cursor) => api(`${base}?before=${cursor}&limit=${PAGE_SIZE}`, messageListSchema),
  );
  const [thread, setThread] = createSignal<MessageView | null>(null);
  const [threadNudge, setThreadNudge] = createSignal(0);
  const others = (): ChatMember[] =>
    (members.data() ?? []).filter((m) => m.handle !== props.myHandle);

  createEffect(
    on(
      props.event,
      (e) => {
        if (!e) return;
        if (e.channelId === null || e.channelId === id) void messages.reload();
        if (e.channelId === null || (e.threadRootId && e.threadRootId === thread()?.id)) {
          setThreadNudge((n) => n + 1);
        }
      },
      { defer: true },
    ),
  );

  // New messages move the view only when the person was already at the bottom.
  let scroller!: HTMLDivElement;
  let atBottom = true;
  const toBottom = (): void => {
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  };
  createEffect(
    on(
      () => history.messages().length,
      () => {
        if (atBottom) toBottom();
      },
    ),
  );

  const send = async (body: string): Promise<void> => {
    await api(base, messageViewSchema, { method: "POST", body: { body } });
    atBottom = true;
    await messages.reload();
  };
  return (
    <>
      <section class="pane" aria-label="Conversation">
        <header class="pane-head">
          <a class="chat-back" href={`#/o/${props.ctx.slug}/chat`}>
            <span aria-hidden="true">‹</span> Channels
          </a>
          <h2>
            <Show when={props.channel()} fallback="Channel">
              {(c) => channelLabel(c(), props.myHandle, props.agents)}
            </Show>
          </h2>
        </header>
        <WorkingStrip
          slug={props.ctx.slug}
          channelId={id}
          members={props.ctx.byHandle}
          bump={() => props.event()?.seq}
        />
        <Show when={messages.error()}>
          {(message) => (
            <p class="error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div
          class="pane-scroll"
          ref={scroller}
          onScroll={() => {
            atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
          }}
        >
          <Show when={!messages.loading()} fallback={<State kind="loading" />}>
            <MessageList history={history} ctx={props.ctx} onOpenThread={setThread} />
          </Show>
        </div>
        <Composer members={others()} label="Message" onSend={send} />
      </section>
      <Show when={thread()} keyed>
        {(root) => (
          <ThreadPanel
            root={root}
            ctx={props.ctx}
            members={others()}
            nudge={threadNudge}
            onClose={() => setThread(null)}
            onPosted={() => void messages.reload()}
          />
        )}
      </Show>
    </>
  );
}

function ChatView(props: { slug: string; orgId: string }): JSX.Element {
  const org = createLoad(`/api/orgs/${props.slug}`, chatOrgSchema);
  const channels = createLoad(`/api/orgs/${props.slug}/channels`, channelListSchema);
  const [dialog, setDialog] = createSignal<DialogKind | null>(null);
  const [event, setEvent] = createSignal<ChatEvent | null>(null);
  const activeId = createMemo(() => {
    const list = channels.data();
    const wanted = routeParts()[3];
    return (list?.find((c) => c.id === wanted) ?? list?.find((c) => c.kind === "org") ?? list?.[0])
      ?.id;
  });
  const active = (): ChannelView | undefined => channels.data()?.find((c) => c.id === activeId());
  const readAndReload = (channelId: string): void => {
    void markRead(channelId).then(channels.reload);
  };
  createEffect(on(activeId, (id) => id && readAndReload(id)));
  createTopic(`org:${props.orgId}`, (m) => {
    if (m && m.type !== "chat") return;
    const channelId = m ? text(m.channelId) : null;
    setEvent((e) => ({
      seq: (e?.seq ?? 0) + 1,
      channelId,
      threadRootId: m ? text(m.threadRootId) : null,
    }));
    if (channelId !== null && channelId === activeId()) readAndReload(channelId);
    else void channels.reload();
  });
  const ctx = (): MessageContext => ({
    slug: props.slug,
    byHandle: new Map((org.data()?.members ?? []).map((m) => [m.handle, m])),
  });
  const agents = (): Set<string> =>
    new Set((org.data()?.members ?? []).filter((m) => m.kind === "agent").map((m) => m.handle));
  const failure = (): string | null => org.error() ?? channels.error();
  return (
    <Show
      when={org.data() && channels.data()}
      fallback={
        <Show when={failure()} fallback={<State kind="loading" />}>
          {(message) => <State kind="error" message={message()} />}
        </Show>
      }
    >
      <div class="chat" data-view={routeParts()[3] ? "conversation" : "list"}>
        <ChannelList
          channels={channels.data() ?? []}
          activeId={activeId() ?? null}
          slug={props.slug}
          myHandle={org.data()?.me.handle ?? ""}
          agents={agents()}
          onNewGroup={() => setDialog("group")}
          onNewDm={() => setDialog("dm")}
        />
        <Show when={activeId()} keyed fallback={<State kind="empty" message="No channels yet." />}>
          {(id) => (
            <Conversation
              channel={active}
              channelId={id}
              ctx={ctx()}
              myHandle={org.data()?.me.handle ?? ""}
              agents={agents()}
              event={event}
            />
          )}
        </Show>
        <Show when={dialog()} keyed>
          {(kind) => (
            <ChannelDialog
              kind={kind}
              slug={props.slug}
              members={(org.data()?.members ?? []).filter((m) => m.id !== org.data()?.me.id)}
              onClose={() => setDialog(null)}
              onCreated={(c) => {
                setDialog(null);
                location.hash = `#/o/${props.slug}/chat/${c.id}`;
                void channels.reload();
              }}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}

export function ChatPage(props: { slug: string }): JSX.Element {
  const org = () => me()?.orgs.find((o) => o.slug === props.slug);
  return (
    <Show when={me()} fallback={<State kind="loading" />}>
      <Show when={org()} keyed fallback={<State kind="error" message="Org not found" />}>
        {(o) => <ChatView slug={props.slug} orgId={o.id} />}
      </Show>
    </Show>
  );
}
