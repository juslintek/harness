import { For, type JSX, Show } from "solid-js";
import { createLoad } from "../../load";
import { isMemoryMessage, memoryBase, writeListSchema } from "./memory-data";
import { WriteMeta } from "./write-meta";

// The feed has no per-note filter, so this reads the recent writes and keeps this note's.
export function NoteHistory(props: { slug: string; noteId: string; topic: string }): JSX.Element {
  const feed = createLoad(
    () => `${memoryBase(props.slug)}/writes?agentsOnly=0&limit=50`,
    writeListSchema,
    [props.topic],
    isMemoryMessage,
  );
  const mine = () => (feed.data() ?? []).filter((w) => w.noteId === props.noteId);
  return (
    <>
      <h3 class="memory-h">History</h3>
      <Show when={feed.data() && mine().length === 0}>
        <p class="memory-meta">No recent writes for this note.</p>
      </Show>
      <ul class="memory-plain">
        <For each={mine()}>
          {(w) => (
            <li class="memory-meta">
              <span>
                <WriteMeta write={w} />
              </span>
            </li>
          )}
        </For>
      </ul>
      <a href={`#/o/${props.slug}/memory/writes`}>See all writes for this note</a>
    </>
  );
}
