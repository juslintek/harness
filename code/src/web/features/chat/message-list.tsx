import { useState } from "preact/hooks";
import type { ChatMember, MessageView } from "../../../shared/chat";
import type { History } from "./chat-history";

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
}): preact.JSX.Element | string {
  const { text, ctx } = props;
  if (text.startsWith("@")) {
    return ctx.byHandle.has(text.slice(1)) ? <span class="mention">{text}</span> : text;
  }
  const task = props.tasks.find((t) => t.number === Number(text.slice(1)));
  if (task) {
    return (
      <a class="task-link" href={`#/o/${ctx.slug}/board/${task.projectId}/${task.number}`}>
        {text}
      </a>
    );
  }
  return (
    <span class="task-ref" title="No task with this number">
      {text}
    </span>
  );
}

// Plain text nodes only: a message body is never parsed as HTML.
function MessageText({
  message,
  ctx,
}: {
  message: MessageView;
  ctx: MessageContext;
}): preact.JSX.Element {
  const parts = message.body.split(TOKEN);
  return (
    <p class="body">
      {parts.map((part, i) =>
        i % 2 === 1 ? <Token text={part} ctx={ctx} tasks={message.tasks} /> : part,
      )}
    </p>
  );
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function MessageItem(props: {
  message: MessageView;
  ctx: MessageContext;
  onOpenThread?: (m: MessageView) => void;
}): preact.JSX.Element {
  const { message, ctx, onOpenThread } = props;
  const { author } = message;
  return (
    <li class="message">
      <div class="meta">
        <strong>{author?.displayName ?? "System"}</strong>
        {author?.kind === "agent" && <span class="badge">agent</span>}
        <time class="muted" dateTime={new Date(message.createdAt).toISOString()}>
          {clock(message.createdAt)}
        </time>
      </div>
      <MessageText message={message} ctx={ctx} />
      {onOpenThread && (
        <button type="button" class="link" onClick={() => onOpenThread(message)}>
          {message.replyCount > 0
            ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
            : "Reply"}
        </button>
      )}
    </li>
  );
}

export function LoadOlder({ onLoad }: { onLoad: () => Promise<void> }): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onLoad();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button type="button" class="link" disabled={busy} onClick={click}>
        {busy ? "Loading…" : "Load older messages"}
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function MessageList(props: {
  history: History;
  ctx: MessageContext;
  onOpenThread: (m: MessageView) => void;
}): preact.JSX.Element {
  const { messages, hasOlder, loadOlder } = props.history;
  if (messages.length === 0) return <p class="muted">No messages yet.</p>;
  return (
    <>
      {hasOlder && <LoadOlder onLoad={loadOlder} />}
      <ul class="plain messages" aria-label="Messages">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} ctx={props.ctx} onOpenThread={props.onOpenThread} />
        ))}
      </ul>
    </>
  );
}
