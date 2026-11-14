import {
  type ChatMember,
  type MessageView,
  messageListSchema,
  messageViewSchema,
} from "@shared/chat";
import { createEffect, For, type JSX, on, Show } from "solid-js";
import { api } from "../../api";
import { createLoad } from "../../load";
import { Button } from "../../ui/atoms";
import { Composer } from "./composer";
import { createHistory, PAGE_SIZE } from "./history";
import { LoadOlder, type MessageContext, MessageItem } from "./messages";

export function ThreadPanel(props: {
  root: MessageView;
  ctx: MessageContext;
  members: ChatMember[];
  nudge: () => number;
  onClose: () => void;
  onPosted: () => void;
}): JSX.Element {
  const { root } = props;
  const base = `/api/channels/${root.channelId}/messages`;
  const replies = createLoad(`${base}?thread=${root.id}&limit=${PAGE_SIZE}`, messageListSchema);
  createEffect(on(props.nudge, () => void replies.reload(), { defer: true }));
  const history = createHistory(
    () => replies.data()?.filter((m) => m.threadRootId === root.id),
    (cursor) =>
      api(`${base}?before=${cursor}&limit=${PAGE_SIZE}&thread=${root.id}`, messageListSchema),
  );
  const send = async (body: string): Promise<void> => {
    await api(base, messageViewSchema, { method: "POST", body: { body, threadRootId: root.id } });
    await replies.reload();
    props.onPosted();
  };
  return (
    <aside class="thread" aria-label="Thread">
      <div class="thread-head">
        <h3>Thread</h3>
        <Button size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div class="thread-scroll">
        <Show when={history.hasOlder()}>
          <LoadOlder onLoad={history.loadOlder} />
        </Show>
        <ul class="messages" aria-label="Thread messages">
          <MessageItem message={root} ctx={props.ctx} />
          <For each={history.messages()}>{(m) => <MessageItem message={m} ctx={props.ctx} />}</For>
        </ul>
        <Show when={replies.error()}>
          {(message) => (
            <p class="error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <Composer members={props.members} label="Reply in thread" onSend={send} />
    </aside>
  );
}
