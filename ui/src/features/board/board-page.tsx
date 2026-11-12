import { type Status, type TaskView, taskViewSchema } from "@shared/board";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { z } from "zod";
import { api } from "../../api";
import { createAction } from "../../auth/create-action";
import { ErrorLine } from "../../auth/error-line";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { routeParts } from "../../route";
import { Button, Dialog, Field, State, StatusBadge } from "../../ui/primitives";
import "./board.css";
import { type Notice, postTask, STATUS_TONE, STATUSES } from "./move";
import { TaskPanel } from "./task-panel";

const edgesSchema = z.array(z.object({ taskId: z.string(), dependsOn: z.string() }));
const taskList = z.array(taskViewSchema);

const NARROW = "(max-width: 47.99rem)";
const isOpen = (t: TaskView): boolean => t.status !== "done" && t.status !== "cancelled";
const fmtEstimate = (minutes: number): string =>
  minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`;

// A custom type keeps text dragged in from elsewhere from being read as a task id.
const TASK_MIME = "application/x-harness-task";

function NewTask(props: { projectId: string; onCreated: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const action = createAction();
  const formId = createUniqueId();
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api(`/api/projects/${props.projectId}/tasks`, taskViewSchema, {
        method: "POST",
        body: { title: title() },
      });
      setTitle("");
      setOpen(false);
      props.onCreated();
    });
  };
  return (
    <>
      <Button tone="primary" onClick={() => setOpen(true)}>
        New task
      </Button>
      <Dialog
        open={open()}
        onClose={() => setOpen(false)}
        title="New task"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              type="submit"
              form={formId}
              tone="primary"
              disabled={action.busy() || title().trim() === ""}
            >
              Add
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit}>
          <Field label="Title">
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
          <ErrorLine message={action.error()} />
        </form>
      </Dialog>
    </>
  );
}

interface BoardCtx {
  slug: string;
  byId: () => Map<string, TaskView>;
  subtasks: () => Map<string, number>;
  blockedBy: () => Map<string, number>;
  notice: () => Notice | null;
  openId: () => string | undefined;
  move: (taskId: string, to: Status, beforeId?: string) => Promise<boolean>;
}

function Card(props: { id: string; ctx: BoardCtx }): JSX.Element {
  const task = (): TaskView => props.ctx.byId().get(props.id) as TaskView;
  const selected = (): boolean => props.ctx.openId() === props.id;
  const sub = (): number => props.ctx.subtasks().get(props.id) ?? 0;
  const blocked = (): number => props.ctx.blockedBy().get(props.id) ?? 0;
  return (
    <li
      class="bd-card"
      data-task-id={props.id}
      data-selected={selected()}
      draggable="true"
      onDragStart={(e) => {
        e.dataTransfer?.setData(TASK_MIME, props.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const dragged = e.dataTransfer?.getData(TASK_MIME);
        if (dragged && dragged !== props.id) void props.ctx.move(dragged, task().status, props.id);
      }}
    >
      <a
        class="bd-card-title"
        draggable="false"
        href={`#/o/${props.ctx.slug}/board/${task().projectId}/${task().number}`}
        aria-current={selected() ? "true" : undefined}
      >
        {task().title}
      </a>
      <p class="bd-card-meta">
        <span class="bd-mono">#{task().number}</span>
        <span>{task().assignee ? `@${task().assignee?.handle}` : "Unassigned"}</span>
        <Show when={task().estimateMinutes !== null}>
          <span class="bd-mono">{fmtEstimate(task().estimateMinutes ?? 0)}</span>
        </Show>
      </p>
      <Show when={blocked() > 0 || sub() > 0}>
        <p class="bd-card-note">
          {[
            blocked() > 0 ? `blocked by ${blocked()}` : "",
            sub() > 0 ? `${sub()} ${sub() === 1 ? "subtask" : "subtasks"}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Show>
      <Show when={task().holder}>
        {(holder) => <p class="bd-card-note">held by @{holder().handle}</p>}
      </Show>
      <Show when={props.ctx.notice()?.taskId === props.id && !selected()}>
        <p class="error" role="alert">
          {props.ctx.notice()?.text}
        </p>
      </Show>
    </li>
  );
}

function Column(props: {
  status: Status;
  ids: string[];
  shown: boolean;
  ctx: BoardCtx;
}): JSX.Element {
  const [over, setOver] = createSignal(false);
  return (
    <section
      class="bd-column"
      data-over={over()}
      data-shown={props.shown}
      aria-label={props.status}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dragged = e.dataTransfer?.getData(TASK_MIME);
        if (dragged) void props.ctx.move(dragged, props.status);
      }}
    >
      <h2 class="bd-column-head">
        <StatusBadge tone={STATUS_TONE[props.status]} value={props.status} />
        <span class="bd-mono muted">{props.ids.length}</span>
      </h2>
      <ul class="bd-plain">
        <For each={props.ids}>{(id) => <Card id={id} ctx={props.ctx} />}</For>
      </ul>
    </section>
  );
}

function BoardView(props: { detail: OrgDetail; projectId: string }): JSX.Element {
  const tasks = createLoad(`/api/projects/${props.projectId}/tasks`, taskList);
  const edges = createLoad(`/api/projects/${props.projectId}/deps`, edgesSchema);
  const reloadAll = async (): Promise<void> => {
    await Promise.all([tasks.reload(), edges.reload()]);
  };
  // The first open only repeats the fetches above; later ones catch what was missed while down.
  let opened = false;
  createTopic(`org:${props.detail.org.id}`, (m) => {
    if (m === null ? opened : m.type === "task" && m.projectId === props.projectId)
      void reloadAll();
    if (m === null) opened = true;
  });

  const list = (): TaskView[] => tasks.data() ?? [];
  const byId = createMemo(() => new Map(list().map((t) => [t.id, t])));
  const subtasks = createMemo(() => {
    const counts = new Map<string, number>();
    for (const t of list())
      if (t.parentId) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
    return counts;
  });
  const blockedBy = createMemo(() => {
    const counts = new Map<string, number>();
    for (const e of edges.data() ?? []) {
      const dep = byId().get(e.dependsOn);
      if (dep && isOpen(dep)) counts.set(e.taskId, (counts.get(e.taskId) ?? 0) + 1);
    }
    return counts;
  });
  const openTask = createMemo(() => {
    const number = Number(routeParts()[4]);
    return number > 0 ? list().find((t) => t.number === number) : undefined;
  });
  const openId = createMemo(() => openTask()?.id);
  const idsIn = (status: Status): string[] =>
    list()
      .filter((t) => t.status === status)
      .sort((a, b) => a.rank - b.rank || a.number - b.number)
      .map((t) => t.id);

  const [picked, setPicked] = createSignal<Status | null>(null);
  const shownStatus = (): Status =>
    picked() ?? openTask()?.status ?? STATUSES.find((s) => idsIn(s).length > 0) ?? "backlog";

  const handleOf = (id: string | null): string =>
    list().find((t) => t.assigneeId === id)?.assignee?.handle ??
    list().find((t) => t.holderId === id)?.holder?.handle ??
    props.detail.members.find((m) => m.id === id)?.handle ??
    "unknown";
  const [notice, setNotice] = createSignal<Notice | null>(null);
  const move = async (taskId: string, to: Status, beforeId?: string): Promise<boolean> => {
    let text: string;
    try {
      const result = await postTask(`/api/tasks/${taskId}/move`, { to, beforeId }, handleOf);
      if (result.ok) {
        setNotice(null);
        setPicked(to);
        await reloadAll();
        return true;
      }
      text = result.message;
    } catch (err) {
      text = String(err);
    }
    setNotice({ taskId, text });
    return false;
  };
  const ctx: BoardCtx = {
    slug: props.detail.org.slug,
    byId,
    subtasks,
    blockedBy,
    notice,
    openId,
    move,
  };

  // The task sheet covers the board on a phone, so the board must not stay reachable behind it.
  const narrow = matchMedia(NARROW);
  const [isNarrow, setIsNarrow] = createSignal(narrow.matches);
  const onNarrow = (): void => {
    setIsNarrow(narrow.matches);
  };
  narrow.addEventListener("change", onNarrow);
  onCleanup(() => narrow.removeEventListener("change", onNarrow));
  const covered = (): boolean => isNarrow() && openId() !== undefined;

  // The panel is gone by now, so focus goes back to the card that opened it.
  let lastOpen: string | undefined;
  createEffect(() => {
    const id = openId();
    if (lastOpen && !id) {
      document
        .querySelector<HTMLElement>(`[data-task-id="${lastOpen}"] a`)
        ?.focus({ preventScroll: true });
    }
    lastOpen = id;
  });

  const projectOptions = props.detail.projects;
  return (
    <>
      <div class="bd-board-head" inert={covered()}>
        <label class="bd-board-project">
          <span class="muted">Project</span>
          <select
            onChange={(e) => {
              location.hash = `#/o/${props.detail.org.slug}/board/${e.currentTarget.value}`;
            }}
          >
            <For each={projectOptions}>
              {(p) => (
                <option value={p.id} selected={p.id === props.projectId}>
                  {p.key} {p.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <NewTask projectId={props.projectId} onCreated={() => void reloadAll()} />
      </div>
      <Show when={tasks.error() ?? edges.error()}>
        {(message) => <State kind="error" message={message()} onRetry={() => void reloadAll()} />}
      </Show>
      <Show
        when={tasks.data()}
        fallback={
          <Show when={!tasks.error()}>
            <State kind="loading" />
          </Show>
        }
      >
        <div class="bd-board-layout">
          <div class="bd-board-main" inert={covered()}>
            <fieldset class="bd-chips">
              <legend class="sr-only">Status</legend>
              <For each={STATUSES}>
                {(status) => (
                  <button
                    type="button"
                    class="bd-chip"
                    aria-pressed={shownStatus() === status}
                    onClick={() => setPicked(status)}
                  >
                    {status} <span class="bd-mono muted">{idsIn(status).length}</span>
                  </button>
                )}
              </For>
            </fieldset>
            <div class="bd-board">
              <For each={STATUSES}>
                {(status) => (
                  <Column
                    status={status}
                    ids={idsIn(status)}
                    shown={shownStatus() === status}
                    ctx={ctx}
                  />
                )}
              </For>
            </div>
          </div>
          <Show when={openId()} keyed>
            {(id) => (
              <TaskPanel
                id={id}
                detail={props.detail}
                tasks={list}
                version={tasks.data}
                notice={notice}
                move={move}
                reload={reloadAll}
                handleOf={handleOf}
              />
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}

function BoardLoader(props: { slug: string }): JSX.Element {
  const org = createLoad(() => `/api/orgs/${props.slug}`, orgDetailSchema);
  const detail = (): OrgDetail | undefined =>
    org.data()?.org.slug === props.slug ? org.data() : undefined;
  // A link to a project created after this org was loaded asks once more before giving up.
  const tried = new Set<string>();
  createEffect(() => {
    const wanted = routeParts()[3];
    const loaded = detail();
    if (!wanted || !loaded || loaded.projects.some((p) => p.id === wanted) || tried.has(wanted))
      return;
    tried.add(wanted);
    void org.reload();
  });
  return (
    <Show
      when={detail()}
      keyed
      fallback={
        <Show when={org.error()} fallback={<State kind="loading" />}>
          {(message) => (
            <State kind="error" message={message()} onRetry={() => void org.reload()} />
          )}
        </Show>
      }
    >
      {(loaded) => {
        const project = (): OrgDetail["projects"][number] | undefined =>
          loaded.projects.find((p) => p.id === routeParts()[3]) ?? loaded.projects[0];
        return (
          <Show
            when={project()?.id}
            keyed
            fallback={
              <State
                kind="empty"
                title="No projects yet"
                message="Create a project in Settings to start a board."
              />
            }
          >
            {(projectId) => <BoardView detail={loaded} projectId={projectId} />}
          </Show>
        );
      }}
    </Show>
  );
}

export function BoardPage(props: { slug: string }): JSX.Element {
  return (
    <Show
      when={me()?.orgs.some((o) => o.slug === props.slug)}
      fallback={<State kind="empty" message="Organisation not found." />}
    >
      <BoardLoader slug={props.slug} />
    </Show>
  );
}
