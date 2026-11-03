import { useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import {
  type ProjectMemberView,
  projectMemberSchema,
  type TaskView,
  taskDetailSchema,
  taskViewSchema,
} from "../../../shared/board";
import type { OrgDetail } from "../../../shared/orgs";
import { api, useLoad } from "../../api";
import { errorText } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { postTaskAction } from "./moves-client";
import { TaskComments } from "./task-comments";
import { TaskLinks } from "./task-links";

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

// A remote change only replaces the form while the user has not edited it.
function useTaskFields(task: TaskView): [Fields, (f: Fields) => void] {
  const [form, setForm] = useState(fieldsOf(task));
  const base = useRef(form);
  useEffect(() => {
    const dirty = (Object.keys(form) as (keyof Fields)[]).some((k) => form[k] !== base.current[k]);
    base.current = fieldsOf(task);
    if (!dirty) setForm(base.current);
  }, [task.updatedAt]);
  return [form, setForm];
}

// Writers come from the project, so grantee-org members show up; the current assignee stays
// selectable even when they lost write access, otherwise saving would silently unassign them.
function useAssignees(task: TaskView): ProjectMemberView[] {
  const loaded = useLoad(
    () => api(`/api/projects/${task.projectId}/members`, z.array(projectMemberSchema)),
    [task.projectId],
  );
  const list = loaded.data ?? [];
  if (task.assigneeId === null || list.some((m) => m.id === task.assigneeId)) return list;
  const { assigneeId: id, assignee } = task;
  return [
    ...list,
    {
      id,
      handle: assignee?.handle ?? "unknown",
      displayName: assignee?.displayName ?? "",
      kind: assignee?.kind ?? "human",
      orgName: "",
    },
  ];
}

function TaskEdit({ task, onSaved }: { task: TaskView; onSaved: () => void }): preact.JSX.Element {
  const assignees = useAssignees(task);
  const [form, setForm] = useTaskFields(task);
  const { title, description, estimate, assignee } = form;
  const setTitle = (v: string): void => setForm({ ...form, title: v });
  const setDescription = (v: string): void => setForm({ ...form, description: v });
  const setEstimate = (v: string): void => setForm({ ...form, estimate: v });
  const setAssignee = (v: string): void => setForm({ ...form, assignee: v });
  const action = useAction();
  const save = (e: Event): void => {
    e.preventDefault();
    action
      .run(async () => {
        await api(`/api/tasks/${task.id}`, taskViewSchema, {
          method: "PATCH",
          body: {
            title,
            description,
            estimateMinutes: estimate === "" ? null : Number(estimate),
            assigneeId: assignee === "" ? null : assignee,
          },
        });
        onSaved();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <form onSubmit={save}>
      <label>
        Title
        <input
          value={title}
          required
          maxLength={200}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        Description
        <textarea
          rows={4}
          value={description}
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <div class="row">
        <label>
          Estimate (minutes)
          <input
            type="number"
            min={0}
            value={estimate}
            onInput={(e) => setEstimate(e.currentTarget.value)}
          />
        </label>
        <label>
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.currentTarget.value)}>
            <option value="">Unassigned</option>
            {assignees.map((m) => (
              <option key={m.id} value={m.id}>
                @{m.handle}
                {assignees.some((o) => o.id !== m.id && o.handle === m.handle) && ` (${m.orgName})`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" disabled={action.busy}>
        Save
      </button>
      <ErrorLine message={action.error} />
    </form>
  );
}

function TaskActions({
  task,
  detail,
  onDone,
}: {
  task: TaskView;
  detail: OrgDetail;
  onDone: () => void;
}): preact.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const handleOf = (id: string): string =>
    (task.holderId === id ? task.holder?.handle : undefined) ??
    detail.members.find((m) => m.id === id)?.handle ??
    "unknown";
  const assignee = task.assignee;
  const act = async (verb: "checkout" | "release"): Promise<void> => {
    const r = await postTaskAction(`/api/tasks/${task.id}/${verb}`, {}, handleOf);
    setMessage(r.ok ? null : r.message);
    if (r.ok) onDone();
  };
  const wake = async (): Promise<void> => {
    try {
      await api(`/api/members/${task.assigneeId}/wake`, z.unknown(), {
        method: "POST",
        body: { taskId: task.id },
      });
      setMessage(`Asked @${assignee?.handle} to run now`);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <div class="row">
      <button type="button" onClick={() => void act("checkout")}>
        Checkout
      </button>
      <button type="button" onClick={() => void act("release")}>
        Release
      </button>
      {assignee?.kind === "agent" && (
        <button type="button" onClick={() => void wake()}>
          Run now
        </button>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

export function TaskPanel({
  task,
  detail,
  tasks,
  version,
  reload,
}: {
  task: TaskView;
  detail: OrgDetail;
  tasks: TaskView[];
  version: unknown;
  reload: () => void;
}): preact.JSX.Element {
  const loaded = useLoad(() => api(`/api/tasks/${task.id}`, taskDetailSchema), [task.id, version]);
  const closeHref = `#/o/${detail.org.slug}/board/${task.projectId}`;
  return (
    <aside class="task-panel card" aria-label={`Task #${task.number}`}>
      <p class="row board-head">
        <strong>
          #{task.number} <span class="badge">{task.status}</span>
        </strong>
        <a href={closeHref}>Close</a>
      </p>
      <TaskEdit task={task} onSaved={reload} />
      <TaskActions task={task} detail={detail} onDone={reload} />
      {loaded.error && <ErrorLine message={loaded.error} />}
      {loaded.data && (
        <>
          <TaskLinks detail={loaded.data} tasks={tasks} org={detail} onChange={reload} />
          <TaskComments detail={loaded.data} onChange={reload} />
        </>
      )}
    </aside>
  );
}
