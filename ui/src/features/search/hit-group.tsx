import type { SearchHitView } from "@shared/runs";
import { For, type JSX, Show } from "solid-js";
import { shortStamp } from "../../format";
import { StatusBadge, statusWord } from "../../ui/atoms";
import { CodeBlock } from "../../ui/molecules";
import { MatchText } from "./match-text";

// A hit's snippet is code only for a command; the rest is prose.
function Hit(props: { hit: SearchHitView; query: string }): JSX.Element {
  return (
    <li class="hit">
      <time class="hit-time">{shortStamp(props.hit.ts)}</time>
      <span class="hit-kind">
        <StatusBadge
          tone={props.hit.kind === "error" ? "danger" : "neutral"}
          value={statusWord(props.hit.kind).word}
        />
      </span>
      <Show
        when={props.hit.kind === "tool_call"}
        fallback={
          <p class="hit-text">
            <MatchText text={props.hit.snippet} query={props.query} />
          </p>
        }
      >
        <CodeBlock text={props.hit.snippet} label="command" />
      </Show>
    </li>
  );
}

export function HitGroup(props: {
  runId: string | null;
  hits: SearchHitView[];
  query: string;
}): JSX.Element {
  return (
    <li class="hit-group">
      <div class="hit-group-head">
        <Show when={props.runId} fallback={<span>No run</span>}>
          {(id) => (
            <>
              <a class="mono" href={`#/runs/${id()}`} title={id()}>
                {id().slice(0, 8)}
              </a>
              <span class="muted">
                {props.hits.length} matching {props.hits.length === 1 ? "event" : "events"}
              </span>
              <a class="hit-open" href={`#/runs/${id()}`}>
                Open run
              </a>
            </>
          )}
        </Show>
      </div>
      <ul class="hit-list" aria-label="Matches in this run">
        <For each={props.hits}>{(h) => <Hit hit={h} query={props.query} />}</For>
      </ul>
    </li>
  );
}
