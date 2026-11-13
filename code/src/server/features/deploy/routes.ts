import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type AuthEnv, requireInstanceAdmin } from "../auth/api";
import { type DiscoveryDeps, discoverTargets } from "./targets";

export const discoveryDeps = (deps?: Partial<DiscoveryDeps>): DiscoveryDeps => ({
  sshConfigPath: deps?.sshConfigPath ?? join(homedir(), ".ssh", "config"),
  bin: deps?.bin,
});

export function deployDiscoveryRoutes(deps?: Partial<DiscoveryDeps>): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requireInstanceAdmin);
  app.get("/targets", async (c) => c.json(await discoverTargets(discoveryDeps(deps))));
  return app;
}
