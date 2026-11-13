import type { EventView } from "@shared/runs";
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import { useNow } from "../../ui/organisms";
import { clockTime, EventRow, eventText } from "./event-row";
import { type FilterKey, KindChips, matches } from "./kind-chips";
import { LiveStrip } from "./live-strip";

// Follow keeps the newest event in view inside the list's own scroll box. Scrolling up by hand
// turns it off; "Jump to latest" turns it back on. `unseen` counts events since it went off.
export function EventStream(props: { events: EventView[]; live: boolean }): JSX.Element {
  const now = useNow();
  const [filter, setFilter] = createSignal<FilterKey>("all");
  const [follow, setFollow] = createSignal(true);
  const [seen, setSeen] = createSignal(0);
  let box!: HTMLDivElement;
  const visible = (): EventView[] => props.events.filter((e) => matches(filter(), e.kind));
  const toEnd = (): void => {
    box.scrollTop = box.scrollHeight;
  };
  const choose = (next: boolean): void => {
    if (!next) setSeen(props.events.length);
    setFollow(next);
    if (next) toEnd();
  };
  createEffect(
    on(
      () => [visible().length, filter()],
      () => {
        if (follow()) toEnd();
      },
    ),
  );
  const onScroll = (): void => {
    const fromEnd = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (fromEnd > 24 && follow()) choose(false);
  };
  return (
    <section class="event-stream" aria-label="Events">
      <header class="event-stream-head">
        <h2 class="event-stream-title">
          Events <span class="mono muted">{props.events.length}</span>
        </h2>
        <LiveStrip
          live={props.live}
          now={now()}
          lastEvent={props.events[props.events.length - 1]?.ts}
          follow={follow()}
          onFollow={choose}
          unseen={Math.max(0, props.events.length - seen())}
          onJump={() => choose(true)}
          copyText={visible()
            .map((e) => `${clockTime(e.ts)} ${e.kind} ${eventText(e)}`)
            .join("\n")}
        />
        <KindChips
          current={filter()}
          count={(key) => props.events.filter((e) => matches(key, e.kind)).length}
          onPick={setFilter}
        />
      </header>
      <section
        ref={box}
        class="event-scroll"
        tabindex="0"
        aria-label="Event list"
        onScroll={onScroll}
      >
        <ol class="event-list" aria-label="Run events">
          <For each={visible()}>{(event) => <EventRow event={event} />}</For>
        </ol>
        <Show when={visible().length === 0}>
          <p class="muted event-empty">No events of this kind yet.</p>
        </Show>
      </section>
    </section>
  );
}
