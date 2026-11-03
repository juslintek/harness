import { useState } from "preact/hooks";
import { z } from "zod";
import type { TaskDetail } from "../../../shared/board";
import { api } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";

export function TaskComments({
  detail,
  onChange,
}: {
  detail: TaskDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const [body, setBody] = useState("");
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        await api(`/api/tasks/${detail.task.id}/comments`, z.unknown(), {
          method: "POST",
          body: { body },
        });
        setBody("");
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <section>
      <h4>Comments</h4>
      <ul class="plain">
        {detail.comments.map((c) => (
          <li key={c.id} class="card">
            <p class="muted">
              @{c.author?.handle ?? "system"} {fmtTime(c.createdAt)}
            </p>
            <p class="comment-body">{c.body}</p>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <label>
          Add a comment
          <textarea
            rows={3}
            value={body}
            required
            onInput={(e) => setBody(e.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={action.busy || body.trim() === ""}>
          Comment
        </button>
        <ErrorLine message={action.error} />
      </form>
    </section>
  );
}
