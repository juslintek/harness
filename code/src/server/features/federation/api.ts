import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export interface FederationDeps {
  home: string;
}

export function federationRoutes(_db: Database): Hono {
  return new Hono();
}

export function startFederation(_db: Database, _deps: FederationDeps): () => Promise<void> {
  return async () => {};
}
