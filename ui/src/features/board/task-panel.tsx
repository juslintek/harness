import {
  type CommentView,
  type ProjectMemberView,
  projectMemberSchema,
  type Status,
  type TaskDetail,
  type TaskView,
  taskDetailSchema,
  taskViewSchema,
} from "@shared/board";
import type { OrgDetail } from "@shared/orgs";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { errorText } from "../../format";
import { createLoad } from "../../load";
import { Button, Field, StatusBadge } from "../../ui/primitives";
import { type Notice, postTask, STATUS_TONE, STATUSES } from "./move";

const okSchema = z.object({ ok: z.literal(true) });
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

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface PanelProps {
  id: string;
  detail: OrgDetail;
  tasks: () => TaskView[];
  version: () => unknown;
  notice: () => Notice | null;
  move: (taskId: string, to: Status, beforeId?: string) => Promise<boolean>;
  reload: () => Promise<void>;
  handleOf: (id: string | null) => string;
}

type WithTask = PanelProps & { task: () => TaskView };
type WithInfo = PanelProps & { info: () => TaskDetail };

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

function Actions(props: WithTask): JSX.Element {
  const [message, setMessage] = createSignal<string | null>(null);
  const act = async (verb: "checkout" | "release"): Promise<void> => {
    try {
      const r = await postTask(`/api/tasks/${props.id}/${verb}`, {}, props.handleOf);
      setMessage(r.ok ? null : r.message);
      if (r.ok) await props.reload();
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  const wake = async (): Promise<void> => {
    try {
      await api(`/api/members/${props.task().assigneeId}/wake`, z.unknown(), {
        method: "POST",
        body: { taskId: props.id },
      });
      setMessage(`Asked @${props.task().assignee?.handle} to run now.`);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  return (
    <div class="bd-panel-block">
      <div class="bd-panel-buttons">
        <Button onClick={() => void act("checkout")}>Checkout</Button>
        <Button onClick={() => void act("release")}>Release</Button>
        <Show when={props.task().assignee?.kind === "agent"}>
          <Button onClick={() => void wake()}>Run now</Button>
        </Show>
      </div>
      <Show when={props.task().holder}>
        {(holder) => (
          <p class="muted bd-small">
            Held by @{holder().handle}
            <Show when={props.task().checkedOutAt}>
              {(at) => (
                <>
                  {" "}
                  since <span class="bd-mono">{fmtClock(at())}</span>
                </>
              )}
            </Show>
          </p>
        )}
      </Show>
      <Show when={message()}>
        {(text) => (
          <p class="bd-small" role="alert">
            {text()}
          </p>
        )}
      </Show>
    </div>
  );
}

function Edit(props: WithTask): JSX.Element {
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
                  {s}
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
      <Actions {...props} />
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

function TaskLink(props: { slug: string; task: TaskView }): JSX.Element {
  return (
    <a href={`#/o/${props.slug}/board/${props.task.projectId}/${props.task.number}`}>
      <span class="bd-mono muted">#{props.task.number}</span> {props.task.title}
    </a>
  );
}

function Dependencies(props: WithInfo): JSX.Element {
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
      <h3>Dependencies</h3>
      <ul class="bd-plain bd-rows">
        <For each={props.info().deps}>
          {(d) => (
            <li class="bd-row-item">
              <TaskLink slug={slug} task={d} />
              <StatusBadge tone={STATUS_TONE[d.status]} value={d.status} />
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

function Subtasks(props: WithInfo): JSX.Element {
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
              <StatusBadge tone={STATUS_TONE[s.status]} value={s.status} />
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

function Comments(props: PanelProps & { comments: () => CommentView[] }): JSX.Element {
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

export function TaskPanel(props: PanelProps): JSX.Element {
  const task = (): TaskView => props.tasks().find((t) => t.id === props.id) as TaskView;
  const loaded = createLoad(() => `/api/tasks/${props.id}`, taskDetailSchema);
  // The board refetch says something changed; the detail has subtasks, deps and comments of its own.
  let first = true;
  createEffect(() => {
    props.version();
    if (!first) void loaded.reload();
    first = false;
  });
  let panel!: HTMLElement;
  onMount(() => panel.focus());
  const closeHref = `#/o/${props.detail.org.slug}/board/${task().projectId}`;
  return (
    <aside class="bd-task-panel" aria-label={`Task #${task().number}`} tabindex="-1" ref={panel}>
      <header class="bd-task-panel-head">
        <span class="bd-mono">#{task().number}</span>
        <a href={closeHref}>
          <span class="bd-when-wide">Close</span>
          <span class="bd-when-narrow">Back</span>
        </a>
      </header>
      <div class="bd-task-panel-body">
        <Edit {...props} task={task} />
        <ErrorLine message={loaded.error()} />
        <Show when={loaded.data()}>
          {(info) => (
            <>
              <Dependencies {...props} info={info} />
              <Subtasks {...props} info={info} />
              <Comments {...props} comments={() => info().comments} />
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}
