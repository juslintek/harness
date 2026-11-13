import { type SearchHitView, searchHitSchema } from "@shared/runs";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../ui/action";
import { Button, Help } from "../../ui/atoms";
import { Field, QueryChips, State } from "../../ui/molecules";
import "../runs/runs.css";
import { HitGroup } from "./hit-group";
import "./search.css";

const hitsSchema = z.array(searchHitSchema);
const EXAMPLES = ["error", "git push", "push-needs-approval"];

// Newest group first, by its newest hit; inside a group the newest hit is first too.
function group(hits: SearchHitView[]): { runId: string | null; hits: SearchHitView[] }[] {
  const byRun = new Map<string | null, SearchHitView[]>();
  for (const h of [...hits].sort((a, b) => b.ts - a.ts)) {
    byRun.set(h.runId, [...(byRun.get(h.runId) ?? []), h]);
  }
  return [...byRun].map(([runId, list]) => ({ runId, hits: list }));
}

export function SearchPage(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [asked, setAsked] = createSignal("");
  const [hits, setHits] = createSignal<SearchHitView[]>();
  const search = createAction();
  const start = (q: string): void => {
    void search.run(async () => {
      setHits(await api(`/api/search?q=${encodeURIComponent(q)}`, hitsSchema));
      setAsked(q);
    });
  };
  return (
    <div class="page-stack">
      <form
        class="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          start(query());
        }}
      >
        <Field label="Search run events">
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
      <Help>
        Searches the events of every run on this server: commands, agent messages, guard decisions.
        It is for instance admins. To search only this organisation, use Logs.
      </Help>
      <Show when={search.error()}>
        {(message) => (
          <p class="error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={hits()}
        fallback={
          <div class="search-intro">
            <h2>Search every event of every run</h2>
            <Help>
              Commands, agent messages and guard decisions. Try a file name, a command or a rule
              name.
            </Help>
            <QueryChips
              queries={EXAMPLES}
              onPick={(q) => {
                setQuery(q);
                start(q);
              }}
            />
          </div>
        }
      >
        {(found) => (
          <Show when={found().length > 0} fallback={<State kind="empty" message="No matches." />}>
            <p class="muted">
              {found().length} {found().length === 1 ? "result" : "results"} for "{asked()}",
              grouped by run
            </p>
            <ul class="hit-groups" aria-label="Search results">
              <For each={group(found())}>
                {(g) => <HitGroup runId={g.runId} hits={g.hits} query={asked()} />}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </div>
  );
}
