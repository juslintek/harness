import type { ChannelKind, ChannelView } from "@shared/chat";
import { createUniqueId, For, type JSX, Show } from "solid-js";
import { Button } from "../../ui/primitives";

const GROUPS: { kind: ChannelKind; title: string }[] = [
  { kind: "org", title: "Organisation" },
  { kind: "team", title: "Teams" },
  { kind: "project", title: "Projects" },
  { kind: "group", title: "Groups" },
  { kind: "dm", title: "Direct messages" },
];

// A dm is named after both handles; the reader only needs the other one.
export function channelLabel(c: ChannelView, myHandle: string): string {
  if (c.kind !== "dm") return c.name;
  return (
    c.name
      .split(", ")
      .filter((h) => h !== myHandle)
      .join(", ") || c.name
  );
}

export function ChannelList(props: {
  channels: ChannelView[];
  activeId: string | null;
  slug: string;
  myHandle: string;
  onNewGroup: () => void;
  onNewDm: () => void;
}): JSX.Element {
  return (
    <nav class="channels" aria-label="Channels">
      <For each={GROUPS}>
        {({ kind, title }) => {
          const id = createUniqueId();
          const items = (): ChannelView[] => props.channels.filter((c) => c.kind === kind);
          return (
            <Show when={items().length > 0}>
              <section>
                <h3 id={id}>{title}</h3>
                <ul aria-labelledby={id}>
                  <For each={items()}>
                    {(c) => (
                      <li>
                        <a
                          href={`#/o/${props.slug}/chat/${c.id}`}
                          aria-current={c.id === props.activeId ? "page" : undefined}
                        >
                          <span class="channel-name">{channelLabel(c, props.myHandle)}</span>
                          <Show when={c.unread > 0}>
                            <span class="unread">
                              {c.unread}
                              <span class="sr-only"> unread</span>
                            </span>
                          </Show>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          );
        }}
      </For>
      <div class="channels-actions">
        <Button size="sm" onClick={props.onNewGroup}>
          New group
        </Button>
        <Button size="sm" onClick={props.onNewDm}>
          New DM
        </Button>
      </div>
    </nav>
  );
}
