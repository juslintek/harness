import type { ChatMember } from "../../../shared/chat";
import { type MessageView, messageListSchema, messageViewSchema } from "../../../shared/chat";
import { api, useLoad } from "../../api";
import { PAGE_SIZE, useHistory } from "./chat-history";
import { Composer } from "./composer";
import { LoadOlder, type MessageContext, MessageItem } from "./message-list";

export function ThreadPanel(props: {
  root: MessageView;
  ctx: MessageContext;
  members: ChatMember[];
  refresh: number;
  onClose: () => void;
  onPosted: () => void;
}): preact.JSX.Element {
  const { root } = props;
  const replies = useLoad(
    () =>
      api(
        `/api/channels/${root.channelId}/messages?thread=${root.id}&limit=${PAGE_SIZE}`,
        messageListSchema,
      ),
    [root.id, props.refresh],
  );
  const history = useHistory(root.channelId, replies.data, root.id);
  const send = async (body: string): Promise<void> => {
    await api(`/api/channels/${root.channelId}/messages`, messageViewSchema, {
      method: "POST",
      body: { body, threadRootId: root.id },
    });
    replies.reload();
    props.onPosted();
  };
  return (
    <aside class="thread" aria-label="Thread">
      <div class="thread-head">
        <h3>Thread</h3>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      {history.hasOlder && <LoadOlder onLoad={history.loadOlder} />}
      <ul class="plain messages">
        <MessageItem message={root} ctx={props.ctx} />
        {history.messages.map((m) => (
          <MessageItem key={m.id} message={m} ctx={props.ctx} />
        ))}
      </ul>
      {replies.error && (
        <p class="error" role="alert">
          {replies.error}
        </p>
      )}
      <Composer members={props.members} label="Reply in thread" onSend={send} />
    </aside>
  );
}
