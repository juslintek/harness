import { useEffect, useState } from "preact/hooks";
import { z } from "zod";
import { type Status, type TaskView, taskViewSchema } from "../../../shared/board";
import type { OrgDetail } from "../../../shared/orgs";
import { api, type Loaded, useLoad, useTopic } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { OrgGate, useOrg } from "../orgs/org-data";
import { Column } from "./column";
import { COLUMNS } from "./move-menu";
import { postTaskAction } from "./moves-client";
import { NewTask } from "./new-task";
import type { BoardCtx } from "./task-card";
import { TaskPanel } from "./task-panel";

const edgesSchema = z.array(z.object({ taskId: z.string(), dependsOn: z.string() }));

interface Pending {
  id: string;
  status: Status;
  seen: unknown;
}

const countBy = <T,>(items: T[], key: (item: T) => string | null): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
};

function useBoard(orgId: string, projectId: string) {
  const board = useLoad(async () => {
    const [tasks, edges] = await Promise.all([
      api(`/api/projects/${projectId}/tasks`, z.array(taskViewSchema)),
      api(`/api/projects/${projectId}/deps`, edgesSchema),
    ]);
    return { tasks, edges };
  }, [projectId]);
  useTopic(`org:${orgId}`, (m) => {
    if (m === null || (m.type === "task" && m.projectId === projectId)) board.reload();
  });
  return board;
}

function ProjectPicker({
  detail,
  projectId,
}: {
  detail: OrgDetail;
  projectId: string;
}): preact.JSX.Element {
  return (
    <label class="inline">
      Project
      <select
        value={projectId}
        onChange={(e) => {
          location.hash = `#/o/${detail.org.slug}/board/${e.currentTarget.value}`;
        }}
      >
        {detail.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.key} {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function useMoves(
  board: Loaded<{ tasks: TaskView[]; edges: unknown[] }>,
  handleOf: (id: string | null) => string,
): { notice: BoardCtx["notice"]; move: BoardCtx["move"] } {
  const [notice, setNotice] = useState<BoardCtx["notice"]>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const move = async (taskId: string, to: Status, beforeId?: string): Promise<void> => {
    const seen = board.data;
    const result = await postTaskAction(`/api/tasks/${taskId}/move`, { to, beforeId }, handleOf);
    if (result.ok) {
      setNotice(null);
      setPending({ id: taskId, status: to, seen });
      board.reload();
    } else setNotice({ taskId, text: result.message });
  };
  // A card that changes column is a new element, so focus goes back to it once the refetch lands.
  useEffect(() => {
    if (!pending || board.data === pending.seen) return;
    if (board.data?.tasks.find((t) => t.id === pending.id)?.status !== pending.status) return;
    document.querySelector<HTMLElement>(`[data-task-id="${pending.id}"] .move-btn`)?.focus();
    setPending(null);
  }, [board.data, pending]);
  useEffect(() => {
    if (board.error) setPending(null);
  }, [board.error]);
  return {
    notice,
    move: (id, to, beforeId) => {
      move(id, to, beforeId).catch((err: unknown) => setNotice({ taskId: id, text: String(err) }));
    },
  };
}

function BoardView({
  detail,
  projectId,
  taskNumber,
}: {
  detail: OrgDetail;
  projectId: string;
  taskNumber: number | null;
}): preact.JSX.Element {
  const board = useBoard(detail.org.id, projectId);
  const handleOf = (id: string | null): string =>
    detail.members.find((m) => m.id === id)?.handle ?? "unknown";
  const { notice, move } = useMoves(board, handleOf);
  const tasks: TaskView[] = board.data?.tasks ?? [];
  const ctx: BoardCtx = {
    slug: detail.org.slug,
    handleOf,
    subtasks: countBy(tasks, (t) => t.parentId),
    deps: countBy(board.data?.edges ?? [], (e) => e.taskId),
    notice,
    move,
  };
  const open = taskNumber === null ? undefined : tasks.find((t) => t.number === taskNumber);
  const inColumn = (status: Status): TaskView[] =>
    tasks.filter((t) => t.status === status).sort((a, b) => a.rank - b.rank || a.number - b.number);
  return (
    <>
      <div class="row board-head">
        <ProjectPicker detail={detail} projectId={projectId} />
        <NewTask projectId={projectId} label="New task" onCreated={board.reload} />
      </div>
      <ErrorLine message={board.error} />
      <div class="board-layout">
        <div class="board">
          {COLUMNS.map((status) => (
            <Column key={status} status={status} ctx={ctx} tasks={inColumn(status)} />
          ))}
        </div>
        {open && (
          <TaskPanel
            key={open.id}
            task={open}
            detail={detail}
            tasks={tasks}
            version={board.data}
            reload={board.reload}
          />
        )}
      </div>
    </>
  );
}

function BoardLoader({
  slug,
  projectId,
  taskNumber,
}: {
  slug: string;
  projectId: string | undefined;
  taskNumber: number | null;
}): preact.JSX.Element {
  const org = useOrg(slug);
  if (org.error)
    return (
      <p class="error" role="alert">
        {org.error}
      </p>
    );
  const detail = org.data;
  if (!detail) return <p class="muted">Loading…</p>;
  const project = detail.projects.find((p) => p.id === projectId) ?? detail.projects[0];
  if (!project) {
    return (
      <p class="muted">
        No projects yet. <a href={`#/o/${slug}/settings`}>Create one in settings.</a>
      </p>
    );
  }
  return (
    <BoardView detail={detail} projectId={project.id} taskNumber={taskNumber} key={project.id} />
  );
}

export function BoardPage({
  slug,
  projectId,
  taskNumber,
}: {
  slug: string;
  projectId?: string;
  taskNumber?: number;
}): preact.JSX.Element {
  return (
    <OrgGate slug={slug}>
      {() => <BoardLoader slug={slug} projectId={projectId} taskNumber={taskNumber ?? null} />}
    </OrgGate>
  );
}
