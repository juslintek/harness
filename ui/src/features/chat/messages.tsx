import type { ChatMember, MessageView } from "@shared/chat";
import { createSignal, For, type JSX, Show } from "solid-js";
import { errorText } from "../../format";
import { Button, StatusBadge } from "../../ui/atoms";
import type { History } from "./history";

const TOKEN =
  /((?<![A-Za-z0-9_@.-])@[a-z0-9][a-z0-9_-]{1,31}(?![a-z0-9_-])|(?<![\w&])#\d{1,9}(?!\w))/g;

export interface MessageContext {
  slug: string;
  byHandle: Map<string, ChatMember>;
}

function Token(props: {
  text: string;
  ctx: MessageContext;
  tasks: MessageView["tasks"];
}): JSX.Element {
  const task = (): MessageView["tasks"][number] | undefined =>
    props.tasks.find((t) => t.number === Number(props.text.slice(1)));
  if (props.text.startsWith("@")) {
    return props.ctx.byHandle.has(props.text.slice(1)) ? (
      <span class="mention">{props.text}</span>
    ) : (
      props.text
    );
  }
  return (
    <Show
      when={task()}
      fallback={
        <span class="task-ref" title="No task with this number">
          {props.text}
        </span>
      }
    >
      {(t) => (
        <a href={`#/o/${props.ctx.slug}/board/${t().projectId}/${t().number}`}>{props.text}</a>
      )}
    </Show>
  );
}

// Plain text nodes only: a message body is never parsed as HTML.
function MessageText(props: { message: MessageView; ctx: MessageContext }): JSX.Element {
  const parts = (): string[] => props.message.body.split(TOKEN);
  return (
    <p class="body">
      <For each={parts()}>
        {(part, i) =>
          i() % 2 === 1 ? <Token text={part} ctx={props.ctx} tasks={props.message.tasks} /> : part
        }
      </For>
    </p>
  );
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function MessageItem(props: {
  message: MessageView;
  ctx: MessageContext;
  onOpenThread?: (m: MessageView) => void;
}): JSX.Element {
  const replies = (): string =>
    props.message.replyCount > 0
      ? `${props.message.replyCount} ${props.message.replyCount === 1 ? "reply" : "replies"}`
      : "Reply";
  // Only an existing thread stays on screen; "Reply" shows on hover or focus, and always on touch.
  return (
    <li class="message">
      <div class="meta">
        <strong>{props.message.author?.displayName ?? "System"}</strong>
        <Show when={props.message.author?.kind === "agent"}>
          <StatusBadge tone="neutral" value="agent" />
        </Show>
        <time dateTime={new Date(props.message.createdAt).toISOString()}>
          {clock(props.message.createdAt)}
        </time>
      </div>
      <MessageText message={props.message} ctx={props.ctx} />
      <Show when={props.onOpenThread}>
        {(open) => (
          <button
            type="button"
            class="link"
            data-quiet={props.message.replyCount === 0}
            onClick={() => open()(props.message)}
          >
            {replies()}
          </button>
        )}
      </Show>
    </li>
  );
}

export function LoadOlder(props: { onLoad: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const click = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.onLoad();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="load-older">
      <Button tone="ghost" size="sm" disabled={busy()} onClick={() => void click()}>
        {busy() ? "Loading…" : "Load older messages"}
      </Button>
      <Show when={error()}>
        {(message) => (
          <p class="error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}

export function MessageList(props: {
  history: History;
  ctx: MessageContext;
  onOpenThread: (m: MessageView) => void;
}): JSX.Element {
  return (
    <Show
      when={props.history.messages().length > 0}
      fallback={<p class="muted">No messages yet.</p>}
    >
      <Show when={props.history.hasOlder()}>
        <LoadOlder onLoad={props.history.loadOlder} />
      </Show>
      <ul class="messages" aria-label="Messages">
        <For each={props.history.messages()}>
          {(m) => <MessageItem message={m} ctx={props.ctx} onOpenThread={props.onOpenThread} />}
        </For>
      </ul>
    </Show>
  );
}
