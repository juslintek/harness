import type { Database } from "bun:sqlite";
import { onMemberRemoved } from "../orgs/api";
import { checkout, moveTask, release } from "./moves";
import {
  addComment,
  addDependency,
  createTask,
  getTask,
  getTaskByNumber,
  listTasks,
  onTaskChange,
  removeDependency,
  taskDetail,
  updateTask,
} from "./repo";

export type { MoveResult } from "./moves";
export type { TaskChange } from "./repo";

export {
  addComment,
  addDependency,
  checkout,
  createTask,
  getTask,
  getTaskByNumber,
  listTasks,
  moveTask,
  onTaskChange,
  release,
  removeDependency,
  taskDetail,
  updateTask,
};

// The FK already nulls holder_id when the member row is deleted, which leaves a stale
// checked_out_at behind that no longer has a holder; clear both here.
export function releaseAllFor(db: Database, memberId: string): void {
  db.query(
    "UPDATE tasks SET holder_id = NULL, checked_out_at = NULL, updated_at = ? WHERE holder_id = ?",
  ).run(Date.now(), memberId);
  db.query(
    "UPDATE tasks SET checked_out_at = NULL WHERE holder_id IS NULL AND checked_out_at IS NOT NULL",
  ).run();
}

let wired = false;

// The listener gets the db from the event, so one subscription serves every database.
export function wireBoard(_db: Database): void {
  if (wired) return;
  wired = true;
  onMemberRemoved((db, member) => releaseAllFor(db, member.id));
}
