import type { Database } from "bun:sqlite";

export function startMemory(_db: Database, _deps: { home: string }): () => Promise<void> {
  return () => Promise.resolve();
}
