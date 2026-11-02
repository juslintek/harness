import { useState } from "preact/hooks";
import { z } from "zod";
import { type SearchHitView, searchHitSchema } from "../../../shared/runs";
import { api } from "../../api";
import { errorText, fmtTime } from "../../format";

const hitsSchema = z.array(searchHitSchema);

export function SearchPage(): preact.JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHitView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: Event): Promise<void> => {
    e.preventDefault();
    try {
      setHits(await api(`/api/search?q=${encodeURIComponent(query)}`, hitsSchema));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <h2>Search</h2>
      <form class="row" onSubmit={run}>
        <label>
          Search all run events
          <input
            type="search"
            value={query}
            required
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {error && <p class="error">{error}</p>}
      {hits?.length === 0 && <p class="muted">No matches.</p>}
      <ul class="plain">
        {(hits ?? []).map((hit) => (
          <li class="card" key={hit.rowid}>
            <span class="kind">{hit.kind}</span> <time class="muted">{fmtTime(hit.ts)}</time>
            <pre class="body">{hit.snippet}</pre>
            {hit.runId && <a href={`#/runs/${hit.runId}`}>Open run</a>}
          </li>
        ))}
      </ul>
    </>
  );
}
