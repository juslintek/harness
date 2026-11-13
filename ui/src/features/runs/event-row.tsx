import type { EventView } from "@shared/runs";
import { type JSX, Show } from "solid-js";
import { StatusBadge, statusWord } from "../../ui/atoms";

const KIND_WORD: Record<string, string> = {
  message: "Agent",
  execute: "Process",
  permission: "Permission",
};

const kindWord = (kind: string): string => {
  const word = KIND_WORD[kind] ?? statusWord(kind).word;
  return word.charAt(0).toUpperCase() + word.slice(1);
};

export const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

// The text a person reads for one event, also what "Copy events" puts on the clipboard.
export const eventText = (e: EventView): string => e.command ?? e.body ?? e.toolName ?? "";

export function EventRow(props: { event: EventView }): JSX.Element {
  const e = props.event;
  const text = eventText(e);
  const [first = "", ...rest] = text.split("\n");
  const more = rest.length > 0 || (e.command !== null && e.body !== null) ? text : "";
  return (
    <li
      class="event"
      data-kind={e.kind}
      data-tone={e.guardVerdict === "deny" || e.kind === "error" ? "danger" : undefined}
    >
      <time class="event-time mono">{clockTime(e.ts)}</time>
      <span class="event-kind" title={e.kind}>
        {kindWord(e.kind)}
      </span>
      <div class="event-main">
        <span class="event-text mono">{first || kindWord(e.kind)}</span>
        <Show when={e.guardRule}>
          {(rule) => <span class="event-rule mono">rule {rule()}</span>}
        </Show>
        <Show when={more}>
          {(full) => (
            <details class="event-body">
              <summary>Show all</summary>
              <pre>
                {e.command !== null && e.body !== null ? `${e.command}\n\n${e.body}` : full()}
              </pre>
            </details>
          )}
        </Show>
      </div>
      <span class="event-end">
        <Show when={e.guardVerdict}>
          {(verdict) => <StatusBadge kind="guard" value={verdict()} />}
        </Show>
        <Show when={e.exitCode !== null && e.exitCode !== 0}>
          <span class="event-exit mono">exit {e.exitCode}</span>
        </Show>
      </span>
    </li>
  );
}
