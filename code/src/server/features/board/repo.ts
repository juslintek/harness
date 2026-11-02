import type { Database } from "bun:sqlite";
import type { CommentView, Status, TaskDetail, TaskView } from "../../../shared/board";

type Raw = Record<string, string | number | null>;

// Expected refusals (bad reference, cycle, wrong project) as opposed to database faults.
export class BoardError extends Error {}

export interface TaskChange {
  kind: "created" | "updated" | "moved" | "assigned" | "commented" | "checked_out" | "released";
  task: TaskView;
  by: string;
  commentId?: string;
}

const listeners = new Set<(change: TaskChange) => void>();

export function onTaskChange(fn: (change: TaskChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(change: TaskChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch (err) {
      console.error("board listener failed", err);
    }
  }
}

const taskView = (r: Raw): TaskView => ({
  id: r.id as string,
  orgId: r.org_id as string,
  projectId: r.project_id as string,
  number: r.number as number,
  parentId: r.parent_id as string | null,
  title: r.title as string,
  description: r.description as string,
  status: r.status as Status,
  rank: r.rank as number,
  assigneeId: r.assignee_id as string | null,
  holderId: r.holder_id as string | null,
  checkedOutAt: r.checked_out_at as number | null,
  estimateMinutes: r.estimate_minutes as number | null,
  createdBy: r.created_by as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
const commentView = (r: Raw): CommentView => ({
  id: r.id as string,
  taskId: r.task_id as string,
  authorId: r.author_id as string | null,
  body: r.body as string,
  createdAt: r.created_at as number,
});

export function getTask(db: Database, id: string): TaskView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
  return r ? taskView(r) : null;
}
export function getTaskByNumber(db: Database, orgId: string, number: number): TaskView | null {
  const r = db
    .query<Raw, [string, number]>("SELECT * FROM tasks WHERE org_id = ? AND number = ?")
    .get(orgId, number);
  return r ? taskView(r) : null;
}
export function listTasks(
  db: Database,
  projectId: string,
  filter: { status?: Status; assigneeId?: string } = {},
): TaskView[] {
  return db
    .query<Raw, [string, string | null, string | null]>(
      `SELECT * FROM tasks WHERE project_id = ?1 AND (?2 IS NULL OR status = ?2)
       AND (?3 IS NULL OR assignee_id = ?3) ORDER BY status, rank, number`,
    )
    .all(projectId, filter.status ?? null, filter.assigneeId ?? null)
    .map(taskView);
}

export function listDeps(db: Database, projectId: string): { taskId: string; dependsOn: string }[] {
  return db
    .query<{ taskId: string; dependsOn: string }, [string]>(
      `SELECT d.task_id AS taskId, d.depends_on AS dependsOn FROM task_deps d
       JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
    )
    .all(projectId);
}

export function nextRank(db: Database, projectId: string, status: Status): number {
  const r = db
    .query<{ m: number | null }, [string, string]>(
      "SELECT MAX(rank) AS m FROM tasks WHERE project_id = ? AND status = ?",
    )
    .get(projectId, status);
  return (r?.m ?? 0) + 1;
}

export interface NewTask {
  projectId: string;
  title: string;
  description?: string;
  parentId?: string;
  assigneeId?: string;
  estimateMinutes?: number;
  status?: Status;
  createdBy: string;
}

export function createTask(db: Database, input: NewTask): TaskView {
  const id = Bun.randomUUIDv7();
  const status = input.status ?? "backlog";
  db.transaction(() => {
    const project = db
      .query<{ org_id: string }, [string]>("SELECT org_id FROM projects WHERE id = ?")
      .get(input.projectId);
    if (!project) throw new BoardError(`unknown project: ${input.projectId}`);
    if (input.parentId !== undefined) {
      const parent = getTask(db, input.parentId);
      if (parent?.projectId !== input.projectId)
        throw new BoardError("parent must be in the project");
    }
    const now = Date.now();
    db.query(
      `INSERT INTO tasks (id, org_id, project_id, number, parent_id, title, description, status, rank,
         assignee_id, estimate_minutes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE org_id = ?),
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      project.org_id,
      input.projectId,
      project.org_id,
      input.parentId ?? null,
      input.title,
      input.description ?? "",
      status,
      nextRank(db, input.projectId, status),
      input.assigneeId ?? null,
      input.estimateMinutes ?? null,
      input.createdBy,
      now,
      now,
    );
  })();
  const task = getTask(db, id) as TaskView;
  emit({ kind: "created", task, by: input.createdBy });
  return task;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  estimateMinutes?: number | null;
  assigneeId?: string | null;
}

export function updateTask(db: Database, id: string, patch: TaskPatch, by: string): TaskView {
  const cur = getTask(db, id);
  if (!cur) throw new BoardError(`unknown task: ${id}`);
  db.query(
    `UPDATE tasks SET title = ?, description = ?, estimate_minutes = ?, assignee_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? cur.title,
    patch.description ?? cur.description,
    patch.estimateMinutes === undefined ? cur.estimateMinutes : patch.estimateMinutes,
    patch.assigneeId === undefined ? cur.assigneeId : patch.assigneeId,
    Date.now(),
    id,
  );
  const task = getTask(db, id) as TaskView;
  emit({ kind: patch.assigneeId === undefined ? "updated" : "assigned", task, by });
  return task;
}

export function addDependency(db: Database, taskId: string, dependsOn: string): void {
  const a = getTask(db, taskId);
  const b = getTask(db, dependsOn);
  if (!a || !b) throw new BoardError("unknown task");
  if (a.projectId !== b.projectId) throw new BoardError("dependency must be in the same project");
  const cycle = db
    .query<Raw, [string, string]>(
      `WITH RECURSIVE reach(id) AS (
         SELECT ?1 UNION SELECT d.depends_on FROM task_deps d JOIN reach r ON d.task_id = r.id
       ) SELECT 1 FROM reach WHERE id = ?2`,
    )
    .get(dependsOn, taskId);
  if (cycle) throw new BoardError("dependency cycle");
  db.query("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)").run(
    taskId,
    dependsOn,
  );
}
export function removeDependency(db: Database, taskId: string, dependsOn: string): void {
  db.query("DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?").run(taskId, dependsOn);
}

export function addComment(
  db: Database,
  taskId: string,
  authorId: string,
  body: string,
): CommentView {
  const task = getTask(db, taskId);
  if (!task) throw new BoardError(`unknown task: ${taskId}`);
  const id = Bun.randomUUIDv7();
  db.query(
    "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, taskId, authorId, body, Date.now());
  const row = db.query<Raw, [string]>("SELECT * FROM comments WHERE id = ?").get(id) as Raw;
  emit({ kind: "commented", task, by: authorId, commentId: id });
  return commentView(row);
}

export function getComment(db: Database, id: string): CommentView | null {
  const r = db.query<Raw, [string]>("SELECT * FROM comments WHERE id = ?").get(id);
  return r ? commentView(r) : null;
}

export function taskDetail(db: Database, id: string): TaskDetail {
  const task = getTask(db, id);
  if (!task) throw new BoardError(`unknown task: ${id}`);
  const tasks = (sql: string): TaskView[] => db.query<Raw, [string]>(sql).all(id).map(taskView);
  return {
    task,
    deps: tasks(
      "SELECT t.* FROM tasks t JOIN task_deps d ON d.depends_on = t.id WHERE d.task_id = ? ORDER BY t.number",
    ),
    subtasks: tasks("SELECT * FROM tasks WHERE parent_id = ? ORDER BY rank, number"),
    comments: db
      .query<Raw, [string]>("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id")
      .all(id)
      .map(commentView),
  };
}
