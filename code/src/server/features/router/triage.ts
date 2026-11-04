import type { Database } from "bun:sqlite";
import type { Difficulty, SizeBucket, Specialty, TaskType } from "../../../shared/router";
import { onTaskChange } from "../board/api";
import { type TaskTriage, triageTask } from "../laya/api";

export interface TaskTriageView {
  taskId: string;
  difficulty: Difficulty;
  taskType: TaskType;
  specialty: Specialty | null;
  size: SizeBucket;
  source: "laya" | "fallback";
  p: Record<string, number>;
  createdAt: number;
}

type TriageListener = (taskId: string, triage: TaskTriage) => void;
const listeners = new Set<TriageListener>();

export function onTriaged(listener: TriageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(db: Database, taskId: string, t: TaskTriage): void {
  db.query(
    `INSERT OR REPLACE INTO task_triage (task_id, difficulty, task_type, specialty, size, source, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    t.difficulty,
    t.taskType,
    t.specialty,
    t.size,
    t.source,
    JSON.stringify(t.p),
    Date.now(),
  );
}

// Triage runs after the board call has returned, so a slow or failing Laya never delays task creation;
// the task may also be deleted meanwhile, which the foreign key reports as an error we only log.
export function startTriage(db: Database): () => void {
  return onTaskChange((change) => {
    if (change.kind !== "created") return;
    const { id, title, description } = change.task;
    triageTask(`${title}\n${description}`)
      .then((t) => {
        store(db, id, t);
        for (const listener of listeners) listener(id, t);
      })
      .catch((err) =>
        console.error("task triage failed", id, err instanceof Error ? err.message : err),
      );
  });
}

export function triageOf(db: Database, taskId: string): TaskTriageView | null {
  const r = db.query("SELECT * FROM task_triage WHERE task_id = ?").get(taskId) as Record<
    string,
    string | number | null
  > | null;
  if (!r) return null;
  return {
    taskId,
    difficulty: r.difficulty as Difficulty,
    taskType: r.task_type as TaskType,
    specialty: r.specialty as Specialty | null,
    size: r.size as SizeBucket,
    source: r.source as "laya" | "fallback",
    p: JSON.parse(r.detail as string) as Record<string, number>,
    createdAt: r.created_at as number,
  };
}
