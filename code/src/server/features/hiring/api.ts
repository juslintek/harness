import type { Database } from "bun:sqlite";

export function startHiring(_db: Database): () => void {
  return () => {};
}
