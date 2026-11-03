import type { Database } from "bun:sqlite";

export function startBudgets(_db: Database): () => void {
  return () => {};
}
