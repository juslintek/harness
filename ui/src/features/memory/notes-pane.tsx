import type { OrgDetail } from "@shared/orgs";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { Button, StatusBadge } from "../../ui/atoms";
import { EmptyPanel, Field, Panel, State } from "../../ui/molecules";
import {
  facetsSchema,
  isMemoryMessage,
  kindWord,
  memoryBase,
  noteListSchema,
  notesHash,
  scopeWord,
  shownPath,
  sumCounts,
  writableScopes,
} from "./memory-data";
import { NewNote } from "./note-editor";
import { activeCount, type Filters, NO_FILTERS, NoteFilters } from "./note-filters";
import { NoteView } from "./note-view";

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
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  // The design keeps these controls outside the Notes panel on a phone and inside it otherwise.
  const narrow = matchMedia("(max-width: 760px)");
  const [phone, setPhone] = createSignal(narrow.matches);
  const onNarrow = (): void => {
    setPhone(narrow.matches);
  };
  narrow.addEventListener("change", onNarrow);
  onCleanup(() => narrow.removeEventListener("change", onNarrow));
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
  const error = (): string | null => list.error() ?? facets.error();
  const total = (): number => sumCounts(facets.data()?.scopes ?? {});
  const active = (): string[] =>
    [
      ...Object.entries(filters())
        .filter(([, value]) => value)
        .map(([key, value]) =>
          key === "scope" ? scopeWord(value) : key === "type" ? kindWord(value) : value,
        ),
      q().trim(),
    ].filter(Boolean);
  const summary = (): string => {
    const notes = list.data();
    if (!notes) return "Loading...";
    return active().length > 0
      ? `Showing ${notes.length} of ${total()} notes · ${active().join(", ")}`
      : `${notes.length} notes`;
  };
  const clear = (): void => {
    setFilters(NO_FILTERS);
    setText("");
    setQ("");
  };
  const empty = (): boolean =>
    facets.data() !== undefined &&
    list.data()?.length === 0 &&
    total() === 0 &&
    active().length === 0;
  const firstNote = (): boolean => empty() && !creating() && !props.selectedId;
  const controls = (): JSX.Element => (
    <>
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
          <NoteFilters
            facets={f()}
            filters={filters()}
            open={filtersOpen()}
            onToggleOpen={() => setFiltersOpen(!filtersOpen())}
            onChange={setFilters}
          />
        )}
      </Show>
      <Show when={error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void list.reload()} />}
      </Show>
    </>
  );
  return (
    <Show
      when={!firstNote()}
      fallback={
        <Panel title="Notes">
          <EmptyPanel
            title="No notes yet"
            message="Notes are what your agents remember between tasks: conventions, decisions, commands. This organisation has none yet, so agents start each task without them. Write the first note, or accept a lesson an agent proposes."
          >
            <Show when={canWrite()}>
              <Button tone="primary" onClick={() => setCreating(true)}>
                Write the first note
              </Button>
            </Show>
          </EmptyPanel>
        </Panel>
      }
    >
      <div class="memory-cols">
        <div class="memory-left">
          <Show when={phone()}>
            <div class="memory-side">{controls()}</div>
          </Show>
          <Panel title="Notes">
            <div class="memory-side">
              <Show when={!phone()}>{controls()}</Show>
              <p class="memory-meta" role="status">
                {summary()}
                <Show when={activeCount(filters()) > 0 || q().trim() !== ""}>
                  <Button size="sm" tone="ghost" onClick={clear}>
                    Clear filters
                  </Button>
                </Show>
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
                          <StatusBadge tone="neutral" value={kindWord(n.type)} />
                        </span>
                        <span class="memory-line">{shownPath(n.path)}</span>
                        <span class="memory-line">
                          by {n.sourceAgent} · {n.updated.slice(0, 10)}
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
        </div>
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
          <Show when={!creating() && !props.selectedId && !empty()}>
            <div class="memory-select-hint">
              <State kind="empty" message="Select a note to read it." />
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
