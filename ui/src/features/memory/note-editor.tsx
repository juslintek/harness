import { type NoteScope, type NoteView, noteViewSchema } from "@shared/memory";
import type { OrgDetail } from "@shared/orgs";
import { createSignal, For, type JSX, onMount, type ParentProps, Show } from "solid-js";
import { ApiError, api } from "../../api";
import { me } from "../../auth/me";
import { createAction } from "../../ui/action";
import { Button } from "../../ui/atoms";
import { Field, Panel } from "../../ui/molecules";
import {
  keptAfterReload,
  mayDiscard,
  memoryBase,
  ownProjects,
  writableScopes,
  writeResultSchema,
} from "./memory-data";

function EditorForm(
  props: ParentProps<{ onClose: () => void; onSubmit: () => void; dirty: () => boolean }>,
): JSX.Element {
  return (
    <form
      class="memory-stack memory-editor"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (mayDiscard(props.dirty(), (q) => window.confirm(q))) props.onClose();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      {props.children}
    </form>
  );
}

function FormError(props: { message: string | null }): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="memory-error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
}

export function EditNote(props: {
  slug: string;
  note: NoteView;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [base, setBase] = createSignal(props.note);
  const [draft, setDraft] = createSignal(props.note.body);
  const [kept, setKept] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal(false);
  const action = createAction();
  let field!: HTMLTextAreaElement;
  onMount(() => field.focus());
  const save = (): void => {
    void action.run(async () => {
      try {
        await api(`${memoryBase(props.slug)}/notes/${base().id}`, writeResultSchema, {
          method: "PUT",
          body: { baseHash: base().hash, body: draft() },
        });
        props.onSaved();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict(true);
        else throw err;
      }
    });
  };
  const reload = (): void => {
    void action.run(async () => {
      const fresh = await api(`${memoryBase(props.slug)}/notes/${base().id}`, noteViewSchema);
      setKept(keptAfterReload(kept(), draft(), base().body));
      setDraft(fresh.body);
      setBase(fresh);
      setConflict(false);
    });
  };
  return (
    <EditorForm onClose={props.onClose} onSubmit={save} dirty={() => draft() !== base().body}>
      <Show when={conflict()}>
        <p class="memory-error" role="alert">
          Changed elsewhere. Your draft is kept.{" "}
          <Button size="sm" onClick={reload}>
            Reload
          </Button>
        </p>
      </Show>
      <Field label="Note text">
        {(c) => (
          <textarea
            {...c()}
            ref={field}
            rows={14}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
        )}
      </Field>
      <Show when={kept()}>
        {(text) => (
          <Field label="Your earlier draft (read only, copy what you need)">
            {(c) => <textarea {...c()} rows={8} readOnly value={text()} />}
          </Field>
        )}
      </Show>
      <FormError message={action.error()} />
      <div class="memory-actions">
        <Button type="submit" tone="primary" disabled={action.busy() || conflict()}>
          Save
        </Button>
        <Button onClick={props.onClose}>Cancel</Button>
      </div>
    </EditorForm>
  );
}

export function NewNote(props: {
  detail: OrgDetail;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const projects = ownProjects(props.detail);
  const scopes = writableScopes(
    props.detail.me.role,
    me()?.user.instanceAdmin === true,
    projects.length > 0,
  );
  const [scope, setScope] = createSignal<NoteScope>(scopes[0] ?? "org");
  const [projectId, setProjectId] = createSignal(projects[0]?.id ?? "");
  const [rel, setRel] = createSignal("");
  const [body, setBody] = createSignal("");
  const action = createAction();
  let first!: HTMLSelectElement;
  onMount(() => first.focus());
  const create = (): void => {
    void action.run(async () => {
      const res = await api(`${memoryBase(props.detail.org.slug)}/notes`, writeResultSchema, {
        method: "POST",
        body: {
          scope: scope(),
          ...(scope() === "project" && { projectId: projectId() }),
          rel: rel().endsWith(".md") ? rel() : `${rel()}.md`,
          body: body(),
        },
      });
      props.onCreated(res.note.id);
    });
  };
  return (
    <Panel title="New note">
      <EditorForm
        onClose={props.onClose}
        onSubmit={create}
        dirty={() => body() !== "" || rel() !== ""}
      >
        <div class="memory-actions">
          <Field label="Scope">
            {(c) => (
              <select
                {...c()}
                ref={first}
                value={scope()}
                onChange={(e) => setScope(e.currentTarget.value as NoteScope)}
              >
                <For each={scopes}>{(s) => <option value={s}>{s}</option>}</For>
              </select>
            )}
          </Field>
          <Show when={scope() === "project"}>
            <Field label="Project">
              {(c) => (
                <select
                  {...c()}
                  value={projectId()}
                  onChange={(e) => setProjectId(e.currentTarget.value)}
                >
                  <For each={projects}>{(p) => <option value={p.id}>{p.name}</option>}</For>
                </select>
              )}
            </Field>
          </Show>
          <Field label="Name (lowercase path, for example how-to/deploy)">
            {(c) => (
              <input
                {...c()}
                value={rel()}
                required
                pattern="[a-z0-9._/\-]+"
                onInput={(e) => setRel(e.currentTarget.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Note text">
          {(c) => (
            <textarea
              {...c()}
              rows={12}
              required
              value={body()}
              onInput={(e) => setBody(e.currentTarget.value)}
            />
          )}
        </Field>
        <FormError message={action.error()} />
        <div class="memory-actions">
          <Button type="submit" tone="primary" disabled={action.busy()}>
            Create note
          </Button>
          <Button onClick={props.onClose}>Cancel</Button>
        </div>
      </EditorForm>
    </Panel>
  );
}
