import type { OrgDetail } from "@shared/orgs";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Button, Field, Panel, State, StatusBadge } from "../../ui/primitives";
import { FacetGroup } from "./facet-chips";
import {
  facetsSchema,
  isMemoryMessage,
  memoryBase,
  noteListSchema,
  notesHash,
  shownPath,
  writableScopes,
} from "./memory-data";
import { NewNote } from "./note-editor";
import { NoteView } from "./note-view";

interface Filters {
  scope: string;
  type: string;
  tag: string;
  source: string;
}
const NO_FILTERS: Filters = { scope: "", type: "", tag: "", source: "" };
const DEBOUNCE_MS = 250;

function queryOf(q: string, f: Filters): string {
  const qs = new URLSearchParams({ limit: "50" });
  if (q.trim()) qs.set("q", q.trim());
  for (const [key, value] of Object.entries(f)) if (value) qs.set(key, value);
  return qs.toString();
}

export function NotesPane(props: {
  detail: OrgDetail;
  topic: string;
  selectedId: string | undefined;
}): JSX.Element {
  const slug = (): string => props.detail.org.slug;
  const [text, setText] = createSignal("");
  const [q, setQ] = createSignal("");
  const [filters, setFilters] = createSignal<Filters>(NO_FILTERS);
  const [creating, setCreating] = createSignal(false);
  createEffect(() => {
    const value = text();
    const timer = setTimeout(() => setQ(value), DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const facets = createLoad(
    () => `${memoryBase(slug())}/facets`,
    facetsSchema,
    [props.topic],
    isMemoryMessage,
  );
  const list = createLoad(
    () => `${memoryBase(slug())}/notes?${queryOf(q(), filters())}`,
    noteListSchema,
    [props.topic],
    isMemoryMessage,
  );
  const canWrite = (): boolean =>
    writableScopes(
      props.detail.me.role,
      me()?.user.instanceAdmin === true,
      props.detail.projects.length > 0,
    ).length > 0;
  const toggle = (key: keyof Filters) => (value: string) =>
    setFilters({ ...filters(), [key]: value });
  const error = (): string | null => list.error() ?? facets.error();
  return (
    <div class="memory-cols">
      <Panel title="Notes">
        <div class="memory-side">
          <Show when={canWrite()}>
            <Button tone="primary" onClick={() => setCreating(true)}>
              New note
            </Button>
          </Show>
          <Field label="Search notes">
            {(c) => (
              <input
                {...c()}
                type="search"
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
              />
            )}
          </Field>
          <Show when={facets.data()}>
            {(f) => (
              <>
                <FacetGroup
                  label="Scope"
                  counts={f().scopes}
                  active={filters().scope}
                  onToggle={toggle("scope")}
                />
                <FacetGroup
                  label="Type"
                  counts={f().types}
                  active={filters().type}
                  onToggle={toggle("type")}
                />
                <FacetGroup
                  label="Tags"
                  counts={f().tags}
                  active={filters().tag}
                  onToggle={toggle("tag")}
                />
                <FacetGroup
                  label="Source"
                  counts={f().sources}
                  active={filters().source}
                  onToggle={toggle("source")}
                />
              </>
            )}
          </Show>
          <Show when={error()}>
            {(message) => (
              <State kind="error" message={message()} onRetry={() => void list.reload()} />
            )}
          </Show>
          <p class="memory-meta" role="status">
            {list.data() ? `${list.data()?.length} notes` : "Loading..."}
          </p>
          <ul class="memory-notes" aria-label="Notes">
            <For each={list.data()}>
              {(n) => (
                <li>
                  <a
                    href={notesHash(slug(), n.id)}
                    aria-current={n.id === props.selectedId ? "true" : undefined}
                  >
                    <span class="memory-note-head">
                      <span>{n.title}</span>
                      <StatusBadge tone="neutral" value={n.type} />
                    </span>
                    <span class="memory-line">
                      {shownPath(n.path)} · {n.updated}
                    </span>
                    <Show when={n.snippet}>
                      <span class="memory-snippet">{n.snippet}</span>
                    </Show>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Panel>
      <div class="memory-stack">
        <Show when={creating()}>
          <NewNote
            detail={props.detail}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              location.hash = notesHash(slug(), id);
            }}
          />
        </Show>
        <Show when={!creating() && props.selectedId} keyed>
          {(id) => <NoteView detail={props.detail} id={id} topic={props.topic} />}
        </Show>
        <Show when={!creating() && !props.selectedId}>
          <State kind="empty" message="Select a note to read it." />
        </Show>
      </div>
    </div>
  );
}
