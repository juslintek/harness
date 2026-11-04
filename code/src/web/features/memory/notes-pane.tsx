import { useEffect, useState } from "preact/hooks";
import type { NoteSummary } from "../../../shared/memory";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { FacetGroup } from "./facet-chips";
import {
  type Facets,
  facetsSchema,
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

function Search({ onQuery }: { onQuery: (q: string) => void }): preact.JSX.Element {
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => onQuery(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <label>
      Search notes
      <input type="search" value={text} onInput={(e) => setText(e.currentTarget.value)} />
    </label>
  );
}

function FacetBar({
  facets,
  filters,
  onChange,
}: {
  facets: Facets;
  filters: Filters;
  onChange: (f: Filters) => void;
}): preact.JSX.Element {
  const toggle = (key: keyof Filters) => (value: string) => onChange({ ...filters, [key]: value });
  return (
    <>
      <FacetGroup
        label="Scope"
        counts={facets.scopes}
        active={filters.scope}
        onToggle={toggle("scope")}
      />
      <FacetGroup
        label="Type"
        counts={facets.types}
        active={filters.type}
        onToggle={toggle("type")}
      />
      <FacetGroup label="Tags" counts={facets.tags} active={filters.tag} onToggle={toggle("tag")} />
      <FacetGroup
        label="Source"
        counts={facets.sources}
        active={filters.source}
        onToggle={toggle("source")}
      />
    </>
  );
}

function NoteList({
  slug,
  notes,
  selectedId,
}: {
  slug: string;
  notes: NoteSummary[] | null;
  selectedId: string | undefined;
}): preact.JSX.Element {
  return (
    <ul class="plain note-list" aria-label="Notes">
      {notes?.map((n) => (
        <li key={n.id}>
          <a href={notesHash(slug, n.id)} aria-current={n.id === selectedId ? "true" : undefined}>
            <strong>{n.title}</strong>
            <span class="muted">{shownPath(n.path)}</span>
            <span class="badge">{n.type}</span>
            <span class="muted">{n.updated}</span>
            {n.snippet && <span class="snippet">{n.snippet}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function NotesPane({
  detail,
  version,
  selectedId,
}: {
  detail: OrgDetail;
  version: number;
  selectedId: string | undefined;
}): preact.JSX.Element {
  const slug = detail.org.slug;
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [creating, setCreating] = useState(false);
  const facets = useLoad(() => api(`${memoryBase(slug)}/facets`, facetsSchema), [slug, version]);
  const list = useLoad(
    () => api(`${memoryBase(slug)}/notes?${queryOf(q, filters)}`, noteListSchema),
    [slug, q, filters, version],
  );
  const canWrite =
    writableScopes(
      detail.me.role,
      me.value?.user.instanceAdmin === true,
      detail.projects.length > 0,
    ).length > 0;
  const f = facets.data;
  return (
    <div class="memory-cols">
      <div class="memory-side">
        {canWrite && (
          <button type="button" onClick={() => setCreating(true)}>
            New note
          </button>
        )}
        <Search onQuery={setQ} />
        {f && <FacetBar facets={f} filters={filters} onChange={setFilters} />}
        <ErrorLine message={list.error ?? facets.error} />
        <p class="muted" role="status">
          {list.data ? `${list.data.length} notes` : "Loading..."}
        </p>
        <NoteList slug={slug} notes={list.data} selectedId={selectedId} />
      </div>
      <div class="memory-main">
        {creating && (
          <NewNote
            detail={detail}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              location.hash = notesHash(slug, id);
            }}
          />
        )}
        {!creating && selectedId && (
          <NoteView key={selectedId} detail={detail} id={selectedId} version={version} />
        )}
        {!creating && !selectedId && <p class="muted">Select a note to read it.</p>}
      </div>
    </div>
  );
}
