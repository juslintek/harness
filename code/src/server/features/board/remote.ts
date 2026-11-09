import type { Database } from "bun:sqlite";
import { checkout, type MoveResult, release } from "./moves";

// Set by the federation slice at startup, so board never imports it. A null answer means the
// task is not on a remote project and the local path runs.
export interface RemoteTasks {
  checkout(db: Database, taskId: string, memberId: string): Promise<MoveResult | null>;
  release(db: Database, taskId: string, memberId: string): Promise<MoveResult | null>;
}

let remote: RemoteTasks | null = null;

export function setRemoteTasks(hooks: RemoteTasks | null): void {
  remote = hooks;
}

export async function checkoutTask(
  db: Database,
  taskId: string,
  memberId: string,
): Promise<MoveResult> {
  return (await remote?.checkout(db, taskId, memberId)) ?? checkout(db, taskId, memberId);
}

export async function releaseTask(
  db: Database,
  taskId: string,
  memberId: string,
): Promise<MoveResult> {
  return (await remote?.release(db, taskId, memberId)) ?? release(db, taskId, memberId);
}
