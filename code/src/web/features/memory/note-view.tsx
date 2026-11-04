import { useState } from "preact/hooks";
import { noteViewSchema } from "../../../shared/memory";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { errorText } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import {
  memoryBase,
  noteListSchema,
  notesHash,
  pickLinkTarget,
  shownPath,
  splitLinks,
  writableScopes,
} from "./memory-data";
import { EditNote } from "./note-editor";

function Body({ slug, text }: { slug: string; text: string }): preact.JSX.Element {
  const [missing, setMissing] = useState<string | null>(null);
  const follow = (target: string): void => {
    const qs = new URLSearchParams({ q: target, limit: "20" });
    api(`${memoryBase(slug)}/notes?${qs}`, noteListSchema).then(
      (hits) => {
        const hit = pickLinkTarget(hits, target);
        if (hit) location.hash = notesHash(slug, hit.id);
        else setMissing(`No note titled "${target}"`);
      },
      (err: unknown) => setMissing(errorText(err)),
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
  const n = note.data;
  if (!n)
    return note.error ? <ErrorLine message="Note not found." /> : <p class="muted">Loading...</p>;
  const canEdit = writableScopes(
    detail.me.role,
    me.value?.user.instanceAdmin === true,
    true,
  ).includes(n.scope);
  return (
    <article class="note-view">
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
          <Body slug={slug} text={n.body} />
          {canEdit && (
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
