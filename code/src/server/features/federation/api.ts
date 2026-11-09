import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import {
  type FederationRouteDeps,
  pairRoute as publicPair,
  federationRoutes as routes,
} from "./routes";

export interface FederationDeps {
  home: string;
}

export function federationRoutes(db: Database, deps: FederationRouteDeps): Hono<AuthEnv> {
  return routes(db, deps);
}

// Public and unsigned; the caller mounts it before the session routes.
export function pairRoute(db: Database, home: string): Hono {
  return publicPair(db, home);
}

export function startFederation(_db: Database, _deps: FederationDeps): () => Promise<void> {
  return async () => {};
}
