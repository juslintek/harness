import type { Status, TaskView } from "../../../shared/board";
import { MoveMenu } from "./move-menu";

// A custom type keeps text dragged in from elsewhere from being read as a task id.
export const TASK_MIME = "application/x-harness-task";

export interface BoardCtx {
  slug: string;
  subtasks: Map<string, number>;
  deps: Map<string, number>;
  notice: { taskId: string; text: string } | null;
  move: (taskId: string, to: Status, beforeId?: string) => void;
}

const fmtEstimate = (minutes: number): string =>
  minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`;

export function TaskCard({ task, ctx }: { task: TaskView; ctx: BoardCtx }): preact.JSX.Element {
  const subtasks = ctx.subtasks.get(task.id) ?? 0;
  const deps = ctx.deps.get(task.id) ?? 0;
  const drop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const dragged = e.dataTransfer?.getData(TASK_MIME);
    if (!dragged || dragged === task.id) return;
    ctx.move(dragged, task.status, task.id);
  };
  return (
    <li
      class="card task"
      data-task-id={task.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer?.setData(TASK_MIME, task.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
    >
      <a class="task-title" href={`#/o/${ctx.slug}/board/${task.projectId}/${task.number}`}>
        <span class="muted">#{task.number}</span> {task.title}
      </a>
      <p class="task-meta">
        {task.assignee && <span>@{task.assignee.handle}</span>}
        {task.estimateMinutes !== null && <span>{fmtEstimate(task.estimateMinutes)}</span>}
        {task.holder && <span class="badge">held by @{task.holder.handle}</span>}
        {deps > 0 && <span>{deps} dep</span>}
        {subtasks > 0 && <span>{subtasks} sub</span>}
      </p>
      <MoveMenu
        label={`Move to… (#${task.number})`}
        taskId={task.id}
        current={task.status}
        onMove={(to) => ctx.move(task.id, to)}
      />
      {ctx.notice?.taskId === task.id && (
        <p class="error" role="alert">
          {ctx.notice.text}
        </p>
      )}
    </li>
  );
}
