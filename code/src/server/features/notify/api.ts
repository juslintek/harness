import type { Database } from "bun:sqlite";
import { createNotifiers } from "./adapters";
import { notifyRoutes } from "./routes";

export { notifyRoutes };

export interface NotifyDeps {
  home: string;
  origin: string;
}

export function startNotify(_db: Database, _deps: NotifyDeps): () => Promise<void> {
  createNotifiers();
  return async () => {};
}
