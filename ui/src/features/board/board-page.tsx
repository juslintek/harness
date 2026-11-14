import type { Status, TaskView } from "@shared/board";
import { taskViewSchema } from "@shared/board";
import { type OrgDetail, orgDetailSchema } from "@shared/orgs";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { me } from "../../auth/me";
import { createLoad } from "../../load";
import { createTopic } from "../../realtime";
import { routeParts } from "../../route";
import { EmptyPanel, Field, State } from "../../ui/molecules";
import { BoardColumn } from "./board-column";
import { BoardFilters, type Filters, NO_FILTER } from "./board-filters";
import "./board.css";
import { type Notice, postTask, STATUSES, statusLabel } from "./move";
import { NewTask } from "./new-task";
import type { BoardCtx } from "./task-card";
import { TaskPanel } from "./task-panel";
import { createWakeups } from "./wakeups";

const edgesSchema = z.array(z.object({ taskId: z.string(), dependsOn: z.string() }));
const taskList = z.array(taskViewSchema);

const NARROW = "(max-width: 47.99rem)";
const isOpen = (t: TaskView): boolean => t.status !== "done" && t.status !== "cancelled";

function BoardView(props: { detail: OrgDetail; projectId: string }): JSX.Element {
  const tasks = createLoad(`/api/projects/${props.projectId}/tasks`, taskList);
  const edges = createLoad(`/api/projects/${props.projectId}/deps`, edgesSchema);
  const wakeups = createWakeups(props.detail.org.slug);
  const reloadAll = async (): Promise<void> => {
    await Promise.all([tasks.reload(), edges.reload(), wakeups.reload()]);
  };
  // Every open refetches, the first too: a task added before the subscription was registered is
  // never pushed.
  createTopic(`org:${props.detail.org.id}`, (m) => {
    if (m === null || (m.type === "task" && m.projectId === props.projectId)) void reloadAll();
  });

  const list = (): TaskView[] => tasks.data() ?? [];
  const byId = createMemo(() => new Map(list().map((t) => [t.id, t])));
  const subtasks = createMemo(() => {
    const counts = new Map<string, number>();
    for (const t of list())
      if (t.parentId) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
    return counts;
  });
  const blockers = createMemo(() => {
    const open = new Map<string, number[]>();
    for (const e of edges.data() ?? []) {
      const dep = byId().get(e.dependsOn);
      if (dep && isOpen(dep)) open.set(e.taskId, [...(open.get(e.taskId) ?? []), dep.number]);
    }
    return open;
  });
  const openTask = createMemo(() => {
    const number = Number(routeParts()[4]);
    return number > 0 ? list().find((t) => t.number === number) : undefined;
  });
  const openId = createMemo(() => openTask()?.id);
  const [filters, setFilters] = createSignal<Filters>(NO_FILTER);
  const shown = (t: TaskView): boolean => {
    const f = filters();
    const text = f.text.trim().toLowerCase().replace(/^#/, "");
    return (
      (f.assignee === "" || t.assignee?.handle === f.assignee) &&
      (!f.heldByAgent || t.holder?.kind === "agent") &&
      (text === "" || t.title.toLowerCase().includes(text) || String(t.number) === text)
    );
  };
  const handles = createMemo(() =>
    [...new Set(list().flatMap((t) => (t.assignee ? [t.assignee.handle] : [])))].sort(),
  );
  const idsIn = (status: Status): string[] =>
    list()
      .filter((t) => t.status === status && shown(t))
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
    blockers,
    work: wakeups.work,
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
  const empty = (): boolean => tasks.data()?.length === 0;
  return (
    <div class="bd-board-layout" data-compact={openId() !== undefined}>
      <div class="bd-board-main" inert={covered()}>
        <div class="bd-board-head" inert={covered()}>
          <div class="bd-board-project">
            <Field label="Project">
              {(control) => (
                <select
                  {...control()}
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
              )}
            </Field>
          </div>
          <Show when={tasks.data() && !empty()}>
            <BoardFilters value={filters} onChange={setFilters} handles={handles} />
            <div class="bd-board-new">
              <NewTask projectId={props.projectId} onCreated={() => void reloadAll()} />
            </div>
          </Show>
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
          <Show
            when={!empty()}
            fallback={
              <EmptyPanel
                title="No tasks yet"
                message="Tasks you add show up here, one column for each status."
              >
                <NewTask projectId={props.projectId} onCreated={() => void reloadAll()} />
              </EmptyPanel>
            }
          >
            <div class="bd-filter-row">
              <div class="bd-status-select">
                <Field label="Status">
                  {(control) => (
                    <select
                      {...control()}
                      onChange={(e) => setPicked(e.currentTarget.value as Status)}
                    >
                      <For each={STATUSES}>
                        {(status) => (
                          <option value={status} selected={shownStatus() === status}>
                            {statusLabel(status)} {idsIn(status).length}
                          </option>
                        )}
                      </For>
                    </select>
                  )}
                </Field>
              </div>
            </div>
            <div class="bd-summary">
              <Show
                when={openId() === undefined}
                fallback={
                  <p class="bd-hint muted">
                    A task is open, so the board shows one line per task. Close the task to see the
                    columns again.
                  </p>
                }
              >
                <p class="bd-counts">
                  <For each={STATUSES}>
                    {(status) => (
                      <span>
                        {statusLabel(status)} <b>{idsIn(status).length}</b>
                      </span>
                    )}
                  </For>
                </p>
                <p class="bd-hint muted">Scroll sideways for the last columns.</p>
              </Show>
            </div>
            <div class="bd-board">
              <For each={STATUSES}>
                {(status) => (
                  <BoardColumn
                    status={status}
                    ids={idsIn(status)}
                    shown={shownStatus() === status}
                    ctx={ctx}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={tasks.data() && openId()} keyed>
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
            work={wakeups.work}
            wakeups={() => wakeups.of(id)}
            reloadWakeups={wakeups.reload}
          />
        )}
      </Show>
    </div>
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
