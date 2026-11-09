import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import { deployDiscoveryRoutes } from "./routes";
import type { DiscoveryDeps } from "./targets";

export interface DeployDeps {
  home: string;
}

export function deployRoutes(_db: Database, discovery?: Partial<DiscoveryDeps>): Hono<AuthEnv> {
  return deployDiscoveryRoutes(discovery);
}

export function startDeploy(_db: Database, _deps: DeployDeps): () => Promise<void> {
  return async () => {};
}
