import type { ChatMember } from "@shared/chat";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { errorText } from "../../format";
import { Button } from "../../ui/primitives";

const TRAILING_MENTION = /(?<![A-Za-z0-9_@.-])@([a-z0-9_-]*)$/;

// Suggestions follow the caret: only the text before it decides whether a mention is being typed.
function mentionQuery(text: string, caret: number): string | null {
  const match = TRAILING_MENTION.exec(text.slice(0, caret));
  return match ? (match[1] ?? "") : null;
}

export function Composer(props: {
  members: ChatMember[];
  label: string;
  onSend: (body: string) => Promise<void>;
}): JSX.Element {
  const listId = createUniqueId();
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closed, setClosed] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let field!: HTMLTextAreaElement;
  // Closes the gap before the busy state shows, so a double Enter posts once.
  let inFlight = false;

  const options = (): ChatMember[] => {
    const query = closed() ? null : mentionQuery(text(), caret());
    return query === null
      ? []
      : props.members.filter((m) => m.handle.startsWith(query)).slice(0, 8);
  };
  const open = (): boolean => options().length > 0;

  const insert = (member: ChatMember): void => {
    const before = text().slice(0, caret()).replace(TRAILING_MENTION, `@${member.handle} `);
    const next = before + text().slice(caret());
    field.value = next;
    field.setSelectionRange(before.length, before.length);
    setText(next);
    setCaret(before.length);
    setActive(0);
    field.focus();
  };

  const mentionKey = (e: KeyboardEvent): boolean => {
    const picked = options()[active()];
    if (!picked) return false;
    const count = options().length;
    if (e.key === "ArrowDown") setActive((active() + 1) % count);
    else if (e.key === "ArrowUp") setActive((active() - 1 + count) % count);
    else if (e.key === "Enter" || e.key === "Tab") insert(picked);
    else if (e.key === "Escape") setClosed(true);
    else return false;
    return true;
  };

  const send = async (): Promise<void> => {
    const body = text().trim();
    if (!body || inFlight) return;
    inFlight = true;
    setBusy(true);
    try {
      await props.onSend(body);
      setText("");
      field.value = "";
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      inFlight = false;
      setBusy(false);
    }
  };

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label class="composer-field">
        <span class="sr-only">{props.label}</span>
        <textarea
          ref={field}
          rows={2}
          placeholder={props.label}
          aria-controls={open() ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open() ? `${listId}-${active()}` : undefined}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
            setActive(0);
            setClosed(false);
          }}
          onKeyDown={(e) => {
            if (mentionKey(e)) e.preventDefault();
            else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        />
      </label>
      <Show when={open()}>
        <div id={listId} class="mentions" role="listbox" aria-label="Mention suggestions">
          <For each={options()}>
            {(m, i) => (
              <div
                id={`${listId}-${i()}`}
                role="option"
                tabIndex={-1}
                aria-selected={i() === active()}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(m);
                }}
              >
                <span class="mono">@{m.handle}</span>{" "}
                <span class="muted">
                  {m.orgName ? `${m.displayName} (${m.orgName})` : m.displayName}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="error composer-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Button type="submit" tone="primary" disabled={busy()}>
        Send
      </Button>
    </form>
  );
}
