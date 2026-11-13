import { taskViewSchema } from "@shared/board";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { Button, StatusBadge } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import type { WithInfo } from "./panel-types";
import { TaskLink } from "./task-link";

export function Subtasks(props: WithInfo): JSX.Element {
  const slug = props.detail.org.slug;
  const [title, setTitle] = createSignal("");
  const action = createAction();
  const count = (): number => props.info().subtasks.length;
  const done = (): number => props.info().subtasks.filter((s) => s.status === "done").length;
  const create = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api(`/api/projects/${props.info().task.projectId}/tasks`, taskViewSchema, {
        method: "POST",
        body: { title: title(), parentId: props.id },
      });
      setTitle("");
      await props.reload();
    });
  };
  return (
    <section class="bd-panel-section">
      <h3>
        Subtasks
        <Show when={count() > 0}>
          {" "}
          · {done()} of {count()} done
        </Show>
      </h3>
      <ul class="bd-plain bd-rows">
        <For each={props.info().subtasks}>
          {(s) => (
            <li class="bd-row-item">
              <input
                type="checkbox"
                aria-label={`Mark #${s.number} done`}
                checked={s.status === "done"}
                disabled={s.status === "done"}
                onChange={(e) => {
                  const box = e.currentTarget;
                  void props.move(s.id, "done").then((ok) => {
                    if (!ok) box.checked = false;
                  });
                }}
              />
              <TaskLink slug={slug} task={s} />
              <StatusBadge kind="task" value={s.status} />
              <Show when={props.notice()?.taskId === s.id}>
                <p class="error bd-small bd-row-error" role="alert">
                  {props.notice()?.text}
                </p>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <form class="bd-inline-form" onSubmit={create}>
        <Field label="New subtask">
          {(control) => (
            <input
              {...control()}
              value={title()}
              required
              maxLength={200}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={action.busy() || title().trim() === ""}>
          Add
        </Button>
      </form>
      <ErrorLine message={action.error()} />
    </section>
  );
}
