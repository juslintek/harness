import { useEffect, useRef, useState } from "preact/hooks";
import { noteSummarySchema, noteViewSchema } from "../../../shared/memory";
import type { OrgDetail } from "../../../shared/orgs";
import { ApiError, api, useLoad } from "../../api";
import { errorText } from "../../format";
import { ErrorLine } from "../auth/error-line";
import {
  memoryBase,
  noteListSchema,
  notesHash,
  shownNote,
  shownPath,
  splitLinks,
} from "./memory-data";
import { EditNote } from "./note-editor";

function Body({ slug, id, text }: { slug: string; id: string; text: string }): preact.JSX.Element {
  const [missing, setMissing] = useState<string | null>(null);
  const follow = (target: string): void => {
    const qs = new URLSearchParams({ target });
    api(`${memoryBase(slug)}/notes/${id}/link?${qs}`, noteSummarySchema).then(
      (hit) => {
        location.hash = notesHash(slug, hit.id);
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
      <pre class="note-body">
        {splitLinks(text).map((part, i) =>
          "link" in part ? (
            <button key={i} type="button" class="wikilink" onClick={() => follow(part.link)}>
              {part.label}
            </button>
          ) : (
            part.text
          ),
        )}
      </pre>
      {missing && (
        <p class="error" role="alert">
          {missing}
        </p>
      )}
    </>
  );
}

export function NoteView({
  detail,
  id,
  version,
}: {
  detail: OrgDetail;
  id: string;
  version: number;
}): preact.JSX.Element {
  const slug = detail.org.slug;
  const [editing, setEditing] = useState(false);
  const note = useLoad(
    () => api(`${memoryBase(slug)}/notes/${id}`, noteViewSchema),
    [slug, id, version],
  );
  const links = useLoad(
    () => api(`${memoryBase(slug)}/notes/${id}/backlinks`, noteListSchema),
    [slug, id, version],
  );
  const n = shownNote(note.data, note.error);
  const article = useRef<HTMLElement>(null);
  // On a phone the list is stacked above the note, so a tapped note would open off screen.
  useEffect(() => article.current?.scrollIntoView({ block: "nearest" }), [n?.id]);
  if (!n)
    return note.error ? <ErrorLine message="Note not found." /> : <p class="muted">Loading...</p>;
  return (
    <article class="note-view" ref={article}>
      <h3>{n.title}</h3>
      <p class="muted">
        {shownPath(n.path)} · {n.scope} · <span class="badge">{n.type}</span> · {n.sourceAgent} ·
        updated {n.updated}
      </p>
      {n.tags.length > 0 && <p class="muted">Tags: {n.tags.join(", ")}</p>}
      {editing ? (
        <EditNote
          slug={slug}
          note={n}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            note.reload();
          }}
        />
      ) : (
        <>
          <Body slug={slug} id={n.id} text={n.body} />
          {n.canWrite && (
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </>
      )}
      <h4>Backlinks</h4>
      {links.data?.length === 0 && <p class="muted">No other note links here.</p>}
      <ul class="plain">
        {links.data?.map((b) => (
          <li key={b.id}>
            <a href={notesHash(slug, b.id)}>{b.title}</a>{" "}
            <span class="muted">{shownPath(b.path)}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
