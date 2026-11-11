import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/api";
import { deployRequestRoutes, type RequestRouteDeps } from "./request-routes";
import { failInterrupted } from "./requests";
import { deployDiscoveryRoutes, discoveryDeps } from "./routes";
import type { DiscoveryDeps } from "./targets";

export interface DeployDeps {
  home: string;
}

export interface DeployRouteDeps extends Omit<RequestRouteDeps, "discovery"> {
  discovery?: Partial<DiscoveryDeps>;
}

export function deployRoutes(db: Database, deps: DeployRouteDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.route("/", deployDiscoveryRoutes(deps.discovery));
  app.route("/", deployRequestRoutes(db, { ...deps, discovery: discoveryDeps(deps.discovery) }));
  return app;
}

export function startDeploy(db: Database, _deps: DeployDeps): () => Promise<void> {
  failInterrupted(db);
  return async () => {};
}
