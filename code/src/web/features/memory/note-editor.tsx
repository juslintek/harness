import { useEffect, useRef, useState } from "preact/hooks";
import { type NoteView, noteViewSchema } from "../../../shared/memory";
import type { OrgDetail } from "../../../shared/orgs";
import { ApiError, api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { me } from "../auth/me";
import { useAction } from "../auth/use-action";
import {
  keptAfterReload,
  mayDiscard,
  memoryBase,
  ownProjects,
  writableScopes,
  writeResultSchema,
} from "./memory-data";

const closeOnEscape = (onClose: () => void, dirty: boolean) => (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.preventDefault();
    if (mayDiscard(dirty, (q) => window.confirm(q))) onClose();
  }
};

function EditorForm({
  onClose,
  onSubmit,
  dirty,
  children,
}: {
  onClose: () => void;
  onSubmit: () => void;
  dirty: boolean;
  children: preact.ComponentChildren;
}): preact.JSX.Element {
  return (
    <form
      class="note-editor"
      onKeyDown={closeOnEscape(onClose, dirty)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

function useFocusOnMount<T extends HTMLElement>(): { current: T | null } {
  const ref = useRef<T | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

export function EditNote({
  slug,
  note,
  onClose,
  onSaved,
}: {
  slug: string;
  note: NoteView;
  onClose: () => void;
  onSaved: () => void;
}): preact.JSX.Element {
  const [base, setBase] = useState(note);
  const [draft, setDraft] = useState(note.body);
  const [kept, setKept] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const action = useAction();
  const field = useFocusOnMount<HTMLTextAreaElement>();
  const save = (): void => {
    action
      .run(async () => {
        try {
          const path = `${memoryBase(slug)}/notes/${base.id}`;
          await api(path, writeResultSchema, {
            method: "PUT",
            body: { baseHash: base.hash, body: draft },
          });
          onSaved();
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) setConflict(true);
          else throw err;
        }
      })
      .catch((err: unknown) => console.error(err));
  };
  const reload = (): void => {
    action
      .run(async () => {
        const fresh = await api(`${memoryBase(slug)}/notes/${base.id}`, noteViewSchema);
        setKept(keptAfterReload(kept, draft, base.body));
        setDraft(fresh.body);
        setBase(fresh);
        setConflict(false);
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <EditorForm onClose={onClose} onSubmit={save} dirty={draft !== base.body}>
      {conflict && (
        <p class="error" role="alert">
          Changed elsewhere. Your draft is kept.{" "}
          <button type="button" onClick={reload}>
            Reload
          </button>
        </p>
      )}
      <label>
        Note text
        <textarea
          ref={field}
          rows={14}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
      </label>
      {kept !== null && (
        <label>
          Your earlier draft (read only, copy what you need)
          <textarea rows={8} readOnly value={kept} />
        </label>
      )}
      <ErrorLine message={action.error} />
      <div class="row">
        <button type="submit" disabled={action.busy || conflict}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </EditorForm>
  );
}

export function NewNote({
  detail,
  onClose,
  onCreated,
}: {
  detail: OrgDetail;
  onClose: () => void;
  onCreated: (id: string) => void;
}): preact.JSX.Element {
  const projects = ownProjects(detail);
  const scopes = writableScopes(
    detail.me.role,
    me.value?.user.instanceAdmin === true,
    projects.length > 0,
  );
  const [scope, setScope] = useState(scopes[0] ?? "org");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [rel, setRel] = useState("");
  const [body, setBody] = useState("");
  const action = useAction();
  const field = useFocusOnMount<HTMLSelectElement>();
  const create = (): void => {
    action
      .run(async () => {
        const res = await api(`${memoryBase(detail.org.slug)}/notes`, writeResultSchema, {
          method: "POST",
          body: {
            scope,
            ...(scope === "project" && { projectId }),
            rel: rel.endsWith(".md") ? rel : `${rel}.md`,
            body,
          },
        });
        onCreated(res.note.id);
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <EditorForm onClose={onClose} onSubmit={create} dirty={body !== "" || rel !== ""}>
      <h3>New note</h3>
      <div class="row">
        <label>
          Scope
          <select
            ref={field}
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value as typeof scope)}
          >
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {scope === "project" && (
          <label>
            Project
            <select value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name (lowercase path, for example how-to/deploy)
          <input
            value={rel}
            required
            pattern="[a-z0-9._/\-]+"
            onInput={(e) => setRel(e.currentTarget.value)}
          />
        </label>
      </div>
      <label>
        Note text
        <textarea rows={12} required value={body} onInput={(e) => setBody(e.currentTarget.value)} />
      </label>
      <ErrorLine message={action.error} />
      <div class="row">
        <button type="submit" disabled={action.busy}>
          Create note
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </EditorForm>
  );
}
