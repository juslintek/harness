import { createSignal, For, type JSX } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { Button, StatusBadge } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import type { WithInfo } from "./panel-types";
import { TaskLink } from "./task-link";

const okSchema = z.object({ ok: z.literal(true) });

export function BlockedBy(props: WithInfo): JSX.Element {
  const [number, setNumber] = createSignal("");
  const [missing, setMissing] = createSignal<string | null>(null);
  const action = createAction();
  const slug = props.detail.org.slug;
  const call = (method: "POST" | "DELETE", dependsOn: string): Promise<void> =>
    action.run(async () => {
      await api(`/api/tasks/${props.id}/deps`, okSchema, { method, body: { dependsOn } });
      setNumber("");
      await props.reload();
    });
  const add = (e: SubmitEvent): void => {
    e.preventDefault();
    const target = props.tasks().find((t) => t.number === Number(number().replace("#", "")));
    setMissing(target ? null : `No task ${number()} in this project.`);
    if (target) void call("POST", target.id);
  };
  return (
    <section class="bd-panel-section">
      <h3>Blocked by</h3>
      <ul class="bd-plain bd-rows">
        <For each={props.info().deps}>
          {(d) => (
            <li class="bd-row-item">
              <TaskLink slug={slug} task={d} />
              <StatusBadge kind="task" value={d.status} />
              <Button
                size="sm"
                tone="ghost"
                aria-label={`Remove dependency #${d.number}`}
                onClick={() => void call("DELETE", d.id)}
              >
                Remove
              </Button>
            </li>
          )}
        </For>
      </ul>
      <form class="bd-inline-form" onSubmit={add}>
        <Field label="Depends on (#n)">
          {(control) => (
            <input
              {...control()}
              value={number()}
              required
              onInput={(e) => setNumber(e.currentTarget.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={action.busy()}>
          Add dependency
        </Button>
      </form>
      <ErrorLine message={missing() ?? action.error()} />
    </section>
  );
}
