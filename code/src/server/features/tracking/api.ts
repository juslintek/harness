import type { Database } from "bun:sqlite";

export function startTracking(_db: Database): () => void {
  return () => {};
}
