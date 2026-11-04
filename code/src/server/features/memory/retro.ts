import type { Database } from "bun:sqlite";
import { onTaskChange } from "../board/api";
import { getMember, getProject } from "../orgs/api";
import { onLessonProposed, reviewerFor } from "./lessons";

export interface RetroDeps {
  enqueueWake: (
    memberId: string,
    reason: "retro" | "lesson_review",
    detail: object,
    taskId: string | null,
  ) => void;
}

function retroSent(db: Database, taskId: string): boolean {
  return (
    db.query("SELECT 1 FROM wakeups WHERE task_id = ? AND reason = 'retro' LIMIT 1").get(taskId) !==
    null
  );
}

export function startRetro(db: Database, deps: RetroDeps): () => void {
  const offTask = onTaskChange((change) => {
    const { task } = change;
    if (change.kind !== "moved" || task.status !== "done" || change.from === "done") return;
    if (task.assigneeId === null) return;
    const assignee = getMember(db, task.assigneeId);
    if (assignee?.kind !== "agent" || assignee.paused || retroSent(db, task.id)) return;
    // A grantee org's agent can hold a task of the owner org; its retro lesson would land in an
    // org that does not own the task, so it gets no wake.
    if (assignee.orgId !== getProject(db, task.projectId)?.orgId) return;
    deps.enqueueWake(
      assignee.id,
      "retro",
      { taskId: task.id, number: task.number, title: task.title },
      task.id,
    );
  });
  const offLesson = onLessonProposed(({ lessons }) => {
    const first = lessons[0];
    const reviewer = first === undefined ? null : reviewerFor(db, first);
    if (first === undefined || reviewer === null) return;
    deps.enqueueWake(
      reviewer,
      "lesson_review",
      { lessonIds: lessons.map((l) => l.id) },
      first.taskId,
    );
  });
  return () => {
    offTask();
    offLesson();
  };
}
