import type { ChannelKind, ChannelView } from "../../../shared/chat";

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
}): preact.JSX.Element {
  return (
    <nav class="channels" aria-label="Channels">
      {GROUPS.map(({ kind, title }) => {
        const items = props.channels.filter((c) => c.kind === kind);
        if (items.length === 0) return null;
        return (
          <section key={kind}>
            <h3>{title}</h3>
            <ul class="plain">
              {items.map((c) => (
                <li key={c.id}>
                  <a
                    href={`#/o/${props.slug}/chat/${c.id}`}
                    aria-current={c.id === props.activeId ? "page" : undefined}
                  >
                    <span>{channelLabel(c, props.myHandle)}</span>
                    {c.unread > 0 && (
                      <span class="badge unread">
                        {c.unread}
                        <span class="sr-only"> unread</span>
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <div class="row">
        <button type="button" onClick={props.onNewGroup}>
          New group
        </button>
        <button type="button" onClick={props.onNewDm}>
          New DM
        </button>
      </div>
    </nav>
  );
}
