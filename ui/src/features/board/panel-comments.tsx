import type { CommentView } from "@shared/board";
import { createSignal, For, type JSX } from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { Button } from "../../ui/atoms";
import { Field } from "../../ui/molecules";
import type { PanelProps } from "./panel-types";

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function Comments(props: PanelProps & { comments: () => CommentView[] }): JSX.Element {
  const [body, setBody] = createSignal("");
  const action = createAction();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api(`/api/tasks/${props.id}/comments`, z.unknown(), {
        method: "POST",
        body: { body: body() },
      });
      setBody("");
      await props.reload();
    });
  };
  return (
    <section class="bd-panel-section">
      <h3>Comments</h3>
      <ul class="bd-plain bd-rows">
        <For each={props.comments()}>
          {(c) => (
            <li class="bd-comment">
              <p class="bd-small">
                <strong>@{c.author?.handle ?? "system"}</strong>{" "}
                <span class="bd-mono muted">{fmtWhen(c.createdAt)}</span>
              </p>
              <p class="bd-comment-body">{c.body}</p>
            </li>
          )}
        </For>
      </ul>
      <form onSubmit={submit}>
        <Field label="Add a comment">
          {(control) => (
            <textarea
              {...control()}
              rows="3"
              value={body()}
              required
              onInput={(e) => setBody(e.currentTarget.value)}
            />
          )}
        </Field>
        <div class="bd-panel-save">
          <Button type="submit" disabled={action.busy() || body().trim() === ""}>
            Comment
          </Button>
        </div>
        <ErrorLine message={action.error()} />
      </form>
    </section>
  );
}
