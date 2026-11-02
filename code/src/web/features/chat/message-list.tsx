import type { ChatMember, MessageView } from "../../../shared/chat";

const TOKEN =
  /((?<![A-Za-z0-9_@.-])@[a-z0-9][a-z0-9_-]{1,31}(?![a-z0-9_-])|(?<![\w&])#\d{1,9}(?!\w))/g;

export interface MessageContext {
  slug: string;
  projectId: string | null;
  byId: Map<string, ChatMember>;
  byHandle: Map<string, ChatMember>;
}

function Token({ text, ctx }: { text: string; ctx: MessageContext }): preact.JSX.Element | string {
  if (text.startsWith("@")) {
    return ctx.byHandle.has(text.slice(1)) ? <span class="mention">{text}</span> : text;
  }
  if (ctx.projectId) {
    return (
      <a class="task-link" href={`#/o/${ctx.slug}/board/${ctx.projectId}/${text.slice(1)}`}>
        {text}
      </a>
    );
  }
  return (
    <span class="task-ref" title="Open the project board to see this task">
      {text}
    </span>
  );
}

// Plain text nodes only: a message body is never parsed as HTML.
function MessageText({ body, ctx }: { body: string; ctx: MessageContext }): preact.JSX.Element {
  const parts = body.split(TOKEN);
  return (
    <p class="body">
      {parts.map((part, i) => (i % 2 === 1 ? <Token text={part} ctx={ctx} /> : part))}
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
  const author = message.authorId ? ctx.byId.get(message.authorId) : undefined;
  return (
    <li class="message">
      <div class="meta">
        <strong>{author?.displayName ?? "System"}</strong>
        {author?.kind === "agent" && <span class="badge">agent</span>}
        <time class="muted" dateTime={new Date(message.createdAt).toISOString()}>
          {clock(message.createdAt)}
        </time>
      </div>
      <MessageText body={message.body} ctx={ctx} />
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

export function MessageList(props: {
  messages: MessageView[];
  ctx: MessageContext;
  onOpenThread: (m: MessageView) => void;
}): preact.JSX.Element {
  if (props.messages.length === 0) return <p class="muted">No messages yet.</p>;
  return (
    <ul class="plain messages" aria-label="Messages">
      {props.messages.map((m) => (
        <MessageItem key={m.id} message={m} ctx={props.ctx} onOpenThread={props.onOpenThread} />
      ))}
    </ul>
  );
}
