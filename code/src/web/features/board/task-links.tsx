import { useState } from "preact/hooks";
import { z } from "zod";
import type { TaskDetail, TaskView } from "../../../shared/board";
import type { OrgDetail } from "../../../shared/orgs";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { NewTask } from "./new-task";

const okSchema = z.object({ ok: z.literal(true) });

function Deps({
  detail,
  tasks,
  slug,
  onChange,
}: {
  detail: TaskDetail;
  tasks: TaskView[];
  slug: string;
  onChange: () => void;
}): preact.JSX.Element {
  const [number, setNumber] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const action = useAction();
  const call = (method: "POST" | "DELETE", dependsOn: string): Promise<void> =>
    action.run(async () => {
      await api(`/api/tasks/${detail.task.id}/deps`, okSchema, { method, body: { dependsOn } });
      setNumber("");
      onChange();
    });
  const add = (e: Event): void => {
    e.preventDefault();
    const target = tasks.find((t) => t.number === Number(number.replace("#", "")));
    setMissing(target ? null : `no task ${number} in this project`);
    if (!target) return;
    call("POST", target.id).catch((err: unknown) => console.error(err));
  };
  return (
    <section>
      <h4>Dependencies</h4>
      <ul class="plain">
        {detail.deps.map((d) => (
          <li key={d.id} class="row">
            <a href={`#/o/${slug}/board/${d.projectId}/${d.number}`}>
              #{d.number} {d.title}
            </a>
            <span class="badge">{d.status}</span>
            <button
              type="button"
              aria-label={`Remove dependency #${d.number}`}
              onClick={() => void call("DELETE", d.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form class="row" onSubmit={add}>
        <label>
          Depends on (#n)
          <input value={number} required onInput={(e) => setNumber(e.currentTarget.value)} />
        </label>
        <button type="submit" disabled={action.busy}>
          Add dependency
        </button>
      </form>
      <ErrorLine message={missing ?? action.error} />
    </section>
  );
}

export function TaskLinks({
  detail,
  tasks,
  org,
  onChange,
}: {
  detail: TaskDetail;
  tasks: TaskView[];
  org: OrgDetail;
  onChange: () => void;
}): preact.JSX.Element {
  const slug = org.org.slug;
  return (
    <>
      <Deps detail={detail} tasks={tasks} slug={slug} onChange={onChange} />
      <section>
        <h4>Subtasks</h4>
        <ul class="plain">
          {detail.subtasks.map((s) => (
            <li key={s.id}>
              <a href={`#/o/${slug}/board/${s.projectId}/${s.number}`}>
                #{s.number} {s.title}
              </a>{" "}
              <span class="badge">{s.status}</span>
            </li>
          ))}
        </ul>
        <NewTask
          projectId={detail.task.projectId}
          parentId={detail.task.id}
          label="New subtask"
          onCreated={onChange}
        />
      </section>
    </>
  );
}
