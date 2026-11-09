import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export interface DeployDeps {
  home: string;
}

export function deployRoutes(_db: Database): Hono {
  return new Hono();
}

export function startDeploy(_db: Database, _deps: DeployDeps): () => Promise<void> {
  return async () => {};
}
