import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatMember } from "../../../shared/chat";

const TRAILING_MENTION = /(?<![A-Za-z0-9_@.-])@([a-z0-9_-]*)$/;

// Suggestions follow the caret: only the text before it decides whether a mention is being typed.
function mentionQuery(text: string, caret: number): string | null {
  const match = TRAILING_MENTION.exec(text.slice(0, caret));
  return match ? (match[1] ?? "") : null;
}

interface Mention {
  options: ChatMember[];
  active: number;
  keyDown: (e: KeyboardEvent) => boolean;
  insert: (m: ChatMember) => void;
  reset: () => void;
}

function useMention(
  members: ChatMember[],
  text: string,
  caret: number,
  put: (text: string, caret: number) => void,
): Mention {
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const query = closed ? null : mentionQuery(text, caret);
  const options =
    query === null ? [] : members.filter((m) => m.handle.startsWith(query)).slice(0, 8);
  const insert = (member: ChatMember): void => {
    const before = text.slice(0, caret).replace(TRAILING_MENTION, `@${member.handle} `);
    put(before + text.slice(caret), before.length);
    setActive(0);
  };
  const keyDown = (e: KeyboardEvent): boolean => {
    const picked = options[active];
    if (!picked) return false;
    if (e.key === "ArrowDown") setActive((active + 1) % options.length);
    else if (e.key === "ArrowUp") setActive((active - 1 + options.length) % options.length);
    else if (e.key === "Enter" || e.key === "Tab") insert(picked);
    else if (e.key === "Escape") setClosed(true);
    else return false;
    return true;
  };
  const reset = (): void => {
    setActive(0);
    setClosed(false);
  };
  return { options, active, keyDown, insert, reset };
}

function MentionList({ mention, id }: { mention: Mention; id: string }): preact.JSX.Element {
  return (
    <div id={id} class="mentions" role="listbox" aria-label="Mention suggestions">
      {mention.options.map((m, i) => (
        <div
          key={m.id}
          id={`${id}-${i}`}
          role="option"
          tabIndex={-1}
          aria-selected={i === mention.active}
          onMouseDown={(e) => {
            e.preventDefault();
            mention.insert(m);
          }}
        >
          @{m.handle} <span class="muted">{m.displayName}</span>
        </div>
      ))}
    </div>
  );
}

// The ref closes the gap before the busy state re-renders, so a double Enter posts once.
function useSender(
  text: string,
  clear: () => void,
  post: (body: string) => Promise<void>,
): { busy: boolean; error: string | null; send: () => Promise<void> } {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await post(body);
      clear();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, error, send };
}

export function Composer(props: {
  members: ChatMember[];
  label: string;
  onSend: (body: string) => Promise<void>;
}): preact.JSX.Element {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const placeCaret = useRef<number | null>(null);
  const mention = useMention(props.members, text, caret, (t, c) => {
    setText(t);
    setCaret(c);
    placeCaret.current = c;
  });
  useEffect(() => {
    if (placeCaret.current === null) return;
    field.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  }, [text]);
  const open = mention.options.length > 0;
  const listId = `mention-${props.label.replaceAll(" ", "-")}`;
  const { busy, error, send } = useSender(text, () => setText(""), props.onSend);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (mention.keyDown(e)) e.preventDefault();
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
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
      <label>
        <span class="sr-only">{props.label}</span>
        <textarea
          ref={field}
          rows={2}
          value={text}
          placeholder={props.label}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${mention.active}` : undefined}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
            mention.reset();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        />
      </label>
      {open && <MentionList mention={mention} id={listId} />}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        Send
      </button>
    </form>
  );
}
