import { type NoteView as Note, noteSummarySchema, noteViewSchema } from "@shared/memory";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { ApiError, api } from "../../api";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { Button, Panel, State, StatusBadge } from "../../ui/primitives";
import {
  isMemoryMessage,
  memoryBase,
  noteListSchema,
  notesHash,
  shownPath,
  splitLinks,
} from "./memory-data";
import { EditNote } from "./note-editor";

function Body(props: { slug: string; id: string; text: string }): JSX.Element {
  const [missing, setMissing] = createSignal<string | null>(null);
  const follow = (target: string): void => {
    const qs = new URLSearchParams({ target });
    api(`${memoryBase(props.slug)}/notes/${props.id}/link?${qs}`, noteSummarySchema).then(
      (hit) => {
        location.hash = notesHash(props.slug, hit.id);
      },
      (err: unknown) =>
        setMissing(
          err instanceof ApiError && err.status === 404
            ? `No note titled "${target}"`
            : errorText(err),
        ),
    );
  };
  return (
    <>
      <pre class="memory-body">
        <For each={splitLinks(props.text)}>
          {(part) =>
            "link" in part ? (
              <button type="button" class="memory-wikilink" onClick={() => follow(part.link)}>
                {part.label}
              </button>
            ) : (
              part.text
            )
          }
        </For>
      </pre>
      <Show when={missing()}>
        {(message) => (
          <p class="memory-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </>
  );
}

export function NoteView(props: { detail: OrgDetail; id: string; topic: string }): JSX.Element {
  const slug = props.detail.org.slug;
  const [editing, setEditing] = createSignal(false);
  const [note, setNote] = createSignal<Note>();
  const [failure, setFailure] = createSignal<{ message: string; status: number | null } | null>(
    null,
  );
  let latest = 0;
  const reload = async (): Promise<void> => {
    const mine = ++latest;
    try {
      const next = await api(`${memoryBase(slug)}/notes/${props.id}`, noteViewSchema);
      if (mine !== latest) return;
      setNote(() => next);
      setFailure(null);
    } catch (err) {
      if (mine === latest)
        setFailure({
          message: errorText(err),
          status: err instanceof ApiError ? err.status : null,
        });
    }
  };
  void reload();
  let opened = false;
  createTopic(props.topic, (frame) => {
    if (frame === null) {
      if (opened) void reload();
      opened = true;
    } else if (isMemoryMessage(frame)) void reload();
  });
  const links = createLoad(
    () => `${memoryBase(slug)}/notes/${props.id}/backlinks`,
    noteListSchema,
    [props.topic],
    isMemoryMessage,
  );
  // Only a 404 means the note was deleted; a timeout or 500 must not make a note vanish.
  const shown = (): Note | undefined => (failure()?.status === 404 ? undefined : note());
  let root!: HTMLDivElement;
  // On a phone the list is stacked above the note, so a tapped note would open off screen.
  onMount(() => root.scrollIntoView({ block: "nearest" }));
  return (
    <div ref={root}>
      <Show
        when={shown()}
        fallback={
          <Show when={failure()} fallback={<State kind="loading" />}>
            {(f) =>
              f().status === 404 ? (
                <State kind="error" message="Note not found." />
              ) : (
                <State
                  kind="error"
                  message="Could not load the note."
                  onRetry={() => void reload()}
                />
              )
            }
          </Show>
        }
      >
        {(n) => (
          <Panel
            title={n().title}
            actions={
              <Show when={n().canWrite && !editing()}>
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </Show>
            }
          >
            <div class="memory-stack">
              <Show when={failure()}>
                <p class="memory-meta">
                  Could not refresh this note.{" "}
                  <Button size="sm" onClick={() => void reload()}>
                    Retry
                  </Button>
                </p>
              </Show>
              <p class="memory-meta">
                <span class="memory-line">{shownPath(n().path)}</span> · <span>{n().scope}</span> ·{" "}
                <StatusBadge tone="neutral" value={n().type} /> · <span>{n().sourceAgent}</span> ·{" "}
                <span>updated {n().updated}</span>
              </p>
              <Show when={n().tags.length > 0}>
                <p class="memory-meta">Tags: {n().tags.join(", ")}</p>
              </Show>
              <Show when={editing()} fallback={<Body slug={slug} id={n().id} text={n().body} />}>
                <EditNote
                  slug={slug}
                  note={n()}
                  onClose={() => setEditing(false)}
                  onSaved={() => {
                    setEditing(false);
                    void reload();
                  }}
                />
              </Show>
              <h3 class="memory-h">Backlinks</h3>
              <Show when={links.data()?.length === 0}>
                <p class="memory-meta">No other note links here.</p>
              </Show>
              <ul class="memory-plain">
                <For each={links.data()}>
                  {(b) => (
                    <li>
                      <a href={notesHash(slug, b.id)}>{b.title}</a>{" "}
                      <span class="memory-line">{shownPath(b.path)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Panel>
        )}
      </Show>
    </div>
  );
}
