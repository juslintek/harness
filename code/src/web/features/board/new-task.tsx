import { useState } from "preact/hooks";
import { type TaskView, taskViewSchema } from "../../../shared/board";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";

export function NewTask({
  projectId,
  parentId,
  label,
  onCreated,
}: {
  projectId: string;
  parentId?: string;
  label: string;
  onCreated: (task: TaskView) => void;
}): preact.JSX.Element {
  const [title, setTitle] = useState("");
  const action = useAction();
  const submit = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        const body = parentId ? { title, parentId } : { title };
        const task = await api(`/api/projects/${projectId}/tasks`, taskViewSchema, {
          method: "POST",
          body,
        });
        setTitle("");
        onCreated(task);
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form class="row" onSubmit={submit}>
      <label>
        {label}
        <input
          value={title}
          required
          maxLength={200}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={action.busy || title.trim() === ""}>
        Add
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}
