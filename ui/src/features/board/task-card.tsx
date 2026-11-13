import type { Status, TaskView } from "@shared/board";
import { type JSX, Show } from "solid-js";
import { useNow } from "../../ui/organisms";
import { isInstanceAdmin, type Work } from "./wakeups";

// A custom type keeps text dragged in from elsewhere from being read as a task id.
export const TASK_MIME = "application/x-harness-task";

const fmtEstimate = (minutes: number): string =>
  minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`;

export interface BoardCtx {
  slug: string;
  byId: () => Map<string, TaskView>;
  subtasks: () => Map<string, number>;
  blockers: () => Map<string, number[]>;
  work: (taskId: string) => Work | undefined;
  notice: () => { taskId: string; text: string } | null;
  openId: () => string | undefined;
  move: (taskId: string, to: Status, beforeId?: string) => Promise<boolean>;
}

function WorkLine(props: { work: Work }): JSX.Element {
  const now = useNow();
  const minutes = (): number | null =>
    props.work.since === null ? null : Math.max(0, Math.floor((now() - props.work.since) / 60_000));
  return (
    <p class="bd-card-work" data-waiting={props.work.waiting}>
      <span aria-hidden="true">●</span>
      <span>{props.work.waiting ? "waiting for you" : "working"}</span>
      <Show when={props.work.runId}>
        {(runId) => (
          <Show when={isInstanceAdmin()} fallback={<span class="bd-mono">{runId()}</span>}>
            <a class="bd-mono" href={`#/runs/${runId()}`} draggable="false">
              {runId()}
            </a>
          </Show>
        )}
      </Show>
      <Show when={minutes() !== null}>
        <span class="bd-mono">{minutes()}m</span>
      </Show>
    </p>
  );
}

export function TaskCard(props: { id: string; ctx: BoardCtx }): JSX.Element {
  const task = (): TaskView => props.ctx.byId().get(props.id) as TaskView;
  const selected = (): boolean => props.ctx.openId() === props.id;
  const sub = (): number => props.ctx.subtasks().get(props.id) ?? 0;
  const waitingOn = (): number[] => props.ctx.blockers().get(props.id) ?? [];
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
      <Show when={props.ctx.work(props.id)}>{(work) => <WorkLine work={work()} />}</Show>
      <Show when={waitingOn().length > 0 || sub() > 0}>
        <p class="bd-card-note">
          <Show when={waitingOn().length > 0}>
            <span class="bd-card-blocked">
              Waiting on{" "}
              {waitingOn()
                .map((n) => `#${n}`)
                .join(", ")}
            </span>
          </Show>
          <Show when={sub() > 0}>
            <span>
              {sub()} {sub() === 1 ? "subtask" : "subtasks"}
            </span>
          </Show>
        </p>
      </Show>
      <Show when={task().holder}>
        {(holder) => <p class="bd-card-note bd-card-held">held by @{holder().handle}</p>}
      </Show>
      <Show when={props.ctx.notice()?.taskId === props.id && !selected()}>
        <p class="error" role="alert">
          {props.ctx.notice()?.text}
        </p>
      </Show>
    </li>
  );
}
