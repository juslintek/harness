import {
  type ProjectMemberView,
  projectMemberSchema,
  type Status,
  type TaskView,
  taskViewSchema,
} from "@shared/board";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  untrack,
} from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { createLoad } from "../../load";
import { Button } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import { STATUSES, statusLabel } from "./move";
import type { WithTask } from "./panel-types";

const memberList = z.array(projectMemberSchema);

interface Fields {
  title: string;
  description: string;
  estimate: string;
  assignee: string;
}

const fieldsOf = (task: TaskView): Fields => ({
  title: task.title,
  description: task.description,
  estimate: task.estimateMinutes?.toString() ?? "",
  assignee: task.assigneeId ?? "",
});

function createAssignees(task: () => TaskView): () => ProjectMemberView[] {
  const members = createLoad(() => `/api/projects/${task().projectId}/members`, memberList);
  // Writers come from the project; the current assignee stays selectable even without write access,
  // otherwise saving would silently unassign them.
  return createMemo(() => {
    const list = members.data() ?? [];
    const current = task();
    if (current.assigneeId === null || list.some((m) => m.id === current.assigneeId)) return list;
    return [
      ...list,
      {
        id: current.assigneeId,
        handle: current.assignee?.handle ?? "unknown",
        displayName: current.assignee?.displayName ?? "",
        kind: current.assignee?.kind ?? "human",
        orgName: "",
      },
    ];
  });
}

// Title, status, assignee and estimate, then whatever the panel puts between them and the
// description (the buttons, runs and blockers), then the description and Save.
export function PanelEdit(
  props: WithTask & { children: JSX.Element; waiting?: JSX.Element },
): JSX.Element {
  const assignees = createAssignees(props.task);
  const formId = createUniqueId();
  const [form, setForm] = createSignal(fieldsOf(props.task()));
  let base = form();
  // A remote change only replaces the form while the user has not edited it.
  createEffect(() => {
    const next = fieldsOf(props.task());
    const current = untrack(form);
    const dirty = (Object.keys(current) as (keyof Fields)[]).some((k) => current[k] !== base[k]);
    base = next;
    if (!dirty) setForm(next);
  });
  const set = (k: keyof Fields, v: string): void => {
    setForm({ ...form(), [k]: v });
  };
  const action = createAction();
  const save = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const f = form();
      await api(`/api/tasks/${props.id}`, taskViewSchema, {
        method: "PATCH",
        body: {
          title: f.title,
          description: f.description,
          estimateMinutes: f.estimate === "" ? null : Number(f.estimate),
          assigneeId: f.assignee === "" ? null : f.assignee,
        },
      });
      await props.reload();
    });
  };
  let statusSelect!: HTMLSelectElement;
  const moveError = (): string | undefined =>
    props.notice()?.taskId === props.id ? props.notice()?.text : undefined;
  return (
    <>
      <div class="bd-title-field">
        <Field label="Title">
          {(control) => (
            <input
              {...control()}
              form={formId}
              class="bd-title-input"
              value={form().title}
              required
              maxLength={200}
              onInput={(e) => set("title", e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
      {props.waiting}
      <Field label="Status">
        {(control) => (
          <select
            {...control()}
            ref={statusSelect}
            onChange={(e) => {
              void props.move(props.id, e.currentTarget.value as Status).then((ok) => {
                if (!ok) statusSelect.value = props.task().status;
              });
            }}
          >
            <For each={STATUSES}>
              {(s) => (
                <option value={s} selected={s === props.task().status}>
                  {statusLabel(s)}
                </option>
              )}
            </For>
          </select>
        )}
      </Field>
      <ErrorLine message={moveError() ?? null} />
      <div class="bd-panel-pair">
        <Field label="Assignee">
          {(control) => (
            <select
              {...control()}
              form={formId}
              onChange={(e) => set("assignee", e.currentTarget.value)}
            >
              <option value="" selected={form().assignee === ""}>
                Unassigned
              </option>
              <For each={assignees()}>
                {(m) => (
                  <option value={m.id} selected={m.id === form().assignee}>
                    @{m.handle}
                    {assignees().some((o) => o.id !== m.id && o.handle === m.handle)
                      ? ` (${m.orgName})`
                      : ""}
                  </option>
                )}
              </For>
            </select>
          )}
        </Field>
        <Field label="Estimate (minutes)">
          {(control) => (
            <input
              {...control()}
              form={formId}
              type="number"
              min="0"
              value={form().estimate}
              onInput={(e) => set("estimate", e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
      {props.children}
      <Field label="Description">
        {(control) => (
          <textarea
            {...control()}
            form={formId}
            rows="5"
            value={form().description}
            onInput={(e) => set("description", e.currentTarget.value)}
          />
        )}
      </Field>
      <form id={formId} class="bd-panel-save" onSubmit={save}>
        <Button type="submit" tone="primary" disabled={action.busy()}>
          Save
        </Button>
        <ErrorLine message={action.error()} />
      </form>
    </>
  );
}
