import type { Database } from "bun:sqlite";

export function startRouter(_db: Database): () => void {
  return () => {};
}
