import { type SearchHitView, searchHitSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { CodeBlock } from "../../ui/code-block";
import { Button, Field, State } from "../../ui/primitives";
import { fmtTime } from "../runs/format";
import "../runs/runs.css";
import "./search.css";

const hitsSchema = z.array(searchHitSchema);

export function SearchPage(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHitView[]>();
  const search = createAction();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void search.run(async () => {
      setHits(await api(`/api/search?q=${encodeURIComponent(query())}`, hitsSchema));
    });
  };
  return (
    <div class="page-stack">
      <form class="search-form" onSubmit={submit}>
        <Field label="Search all run events">
          {(control) => (
            <input
              {...control()}
              type="search"
              value={query()}
              required
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" tone="primary" disabled={search.busy()}>
          Search
        </Button>
      </form>
      <Show when={search.error()}>
        {(message) => (
          <p class="error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={hits()?.length === 0}>
        <State kind="empty" message="No matches." />
      </Show>
      <ul class="hit-list" aria-label="Search results">
        <For each={hits()}>
          {(hit) => (
            <li class="hit">
              <div class="hit-line">
                <span>{hit.kind}</span>
                <time>{fmtTime(hit.ts)}</time>
                <Show when={hit.runId}>
                  {(runId) => <a href={`#/runs/${runId()}`}>Open run</a>}
                </Show>
              </div>
              <CodeBlock text={hit.snippet} label="match" copy={false} />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
