import type { NoteWriteFeedItem } from "@shared/memory";
import { type JSX, Show } from "solid-js";
import { me } from "../../auth/me";
import { minuteStamp } from "../../format";
import { StatusBadge } from "../../ui/atoms";
import { opWord, runHash, shownPath } from "./memory-data";

// One line saying what happened to a note, by whom, when, and which run it came from.
export function WriteMeta(props: { write: NoteWriteFeedItem; withPath?: boolean }): JSX.Element {
  return (
    <>
      <StatusBadge tone="neutral" value={opWord(props.write.op)} />{" "}
      <Show when={props.withPath}>
        <b class="memory-path">{shownPath(props.write.path)}</b>{" "}
      </Show>
      <span>
        {props.withPath ? "by " : ""}
        {props.write.actor} · {minuteStamp(props.write.at)}
      </span>{" "}
      <Show when={props.write.runId} fallback="not from a run">
        {(id) => (
          <>
            in run{" "}
            <Show
              when={me()?.user.instanceAdmin}
              fallback={<span class="memory-line">{id()}</span>}
            >
              <a class="memory-line" href={runHash(id())}>
                {id()}
              </a>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
