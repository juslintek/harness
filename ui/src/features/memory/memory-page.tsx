import { orgDetailSchema } from "@shared/orgs";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { routeParts } from "../../route";
import { State } from "../../ui/primitives";
import { isAdmin } from "../orgs/shared";
import { LessonsPanel } from "./lessons-panel";
import { tabOf, tabsFor } from "./memory-data";
import { NotesPane } from "./notes-pane";
import { WritesPanel } from "./writes-panel";
import "./memory.css";

const LABELS = { notes: "Notes", writes: "Writes", review: "Review" } as const;

function Memory(props: { org: { id: string; slug: string } }): JSX.Element {
  const detail = createLoad(() => `/api/orgs/${props.org.slug}`, orgDetailSchema);
  const topic = `org:${props.org.id}`;
  return (
    <div class="memory">
      <h1 class="memory-title">Memory</h1>
      <Show when={detail.error()}>
        {(message) => (
          <State kind="error" message={message()} onRetry={() => void detail.reload()} />
        )}
      </Show>
      <Show when={detail.loading()}>
        <State kind="loading" />
      </Show>
      <Show when={detail.data()}>
        {(d) => {
          const tabs = (): ReturnType<typeof tabsFor> => tabsFor(d().me.role);
          const tab = (): ReturnType<typeof tabOf> => tabOf(routeParts()[3], tabs());
          return (
            <>
              <nav class="memory-tabs" aria-label="Memory sections">
                <For each={tabs()}>
                  {(t) => (
                    <a
                      href={`#/o/${props.org.slug}/memory/${t}`}
                      aria-current={t === tab() ? "page" : undefined}
                    >
                      {LABELS[t]}
                    </a>
                  )}
                </For>
              </nav>
              <Switch>
                <Match when={tab() === "notes"}>
                  <NotesPane detail={d()} topic={topic} selectedId={routeParts()[4]} />
                </Match>
                <Match when={tab() === "writes"}>
                  <WritesPanel slug={props.org.slug} topic={topic} />
                </Match>
                <Match when={tab() === "review"}>
                  <LessonsPanel detail={d()} admin={isAdmin(d())} topic={topic} />
                </Match>
              </Switch>
            </>
          );
        }}
      </Show>
    </div>
  );
}

export function MemoryPage(props: { slug: string }): JSX.Element {
  const org = (): { id: string; slug: string } | undefined =>
    me()?.orgs.find((o) => o.slug === props.slug);
  return (
    <Show when={org()} fallback={<State kind="empty" message="Org not found" />}>
      {(found) => <Memory org={found()} />}
    </Show>
  );
}
