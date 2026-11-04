import type { Database } from "bun:sqlite";

export interface BridgeDeps {
  home: string;
  origin: string;
}

export function startBridges(_db: Database, _deps: BridgeDeps): () => Promise<void> {
  return async () => {};
}
