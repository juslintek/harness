import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export interface SelfupdateDeps {
  home: string;
}

export function selfupdateRoutes(_db: Database): Hono {
  return new Hono();
}

export function startSelfupdate(_db: Database, _deps: SelfupdateDeps): () => Promise<void> {
  return async () => {};
}
