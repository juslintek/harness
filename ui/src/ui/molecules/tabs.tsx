import { createEffect, For, type JSX, Show } from "solid-js";
import { CountBadge } from "../atoms";
import "./tabs.css";

export interface TabItem {
  key: string;
  label: string;
  href: string;
  count?: number;
  countTone?: "neutral" | "warning";
}

// Tabs that change the hash route, so each one is a link and the current one is marked.
export function Tabs(props: { items: TabItem[]; current: string; label: string }): JSX.Element {
  let nav: HTMLElement | undefined;
  // A row that does not fit scrolls inside its own box; the current tab is brought into view
  // without moving the page.
  createEffect(() => {
    props.current;
    const tab = nav?.querySelector<HTMLElement>("[aria-current]");
    if (nav && tab && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2;
    }
  });
  return (
    <nav class="tabs" aria-label={props.label} ref={nav}>
      <For each={props.items}>
        {(tab) => (
          <a href={tab.href} aria-current={tab.key === props.current ? "page" : undefined}>
            {tab.label}
            <Show when={tab.count}>
              {(count) => <CountBadge count={count()} tone={tab.countTone ?? "neutral"} />}
            </Show>
          </a>
        )}
      </For>
    </nav>
  );
}
