import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { TargetView } from "../../../shared/distribution";
import { notFound, parseBody } from "../../route-kit";
import { type AuthEnv, requireInstanceAdmin, requireStepUp } from "../auth/api";
import { type ExecutorDeps, planView, runDeploy } from "./executor";
import {
  claimRun,
  createRequest,
  type DeployRequest,
  decide,
  getRequest,
  listRequests,
  resolveBinary,
} from "./requests";
import { sshTransport } from "./ssh-transport";
import { type DiscoveryDeps, discoverTargets } from "./targets";

const DEFAULT_PORT = 4100;
const HEALTH_TIMEOUT_MS = 60_000;

const createBody = z.object({
  targetId: z.string().min(1).max(300),
  binary: z
    .string()
    .min(1)
    .max(300)
    .refine((name) => !name.includes("\0")),
  port: z.number().int().min(1).max(65535).optional(),
});
const decideBody = z.object({ decision: z.enum(["approve", "deny"]) });

export interface RequestRouteDeps {
  home: string;
  ownUrl: string;
  discovery: DiscoveryDeps;
  // The instance's own dist dir and the one `bun run build` writes to; nothing else is copyable.
  distDirs?: string[];
  transportFor?: ExecutorDeps["transportFor"];
  healthTimeoutMs?: number;
}

const view = (req: DeployRequest): Record<string, unknown> => ({ ...req, steps: planView(req) });

async function findTarget(deps: DiscoveryDeps, id: string): Promise<TargetView | undefined> {
  return (await discoverTargets(deps)).find((target) => target.id === id);
}

export function deployRequestRoutes(db: Database, deps: RequestRouteDeps): Hono<AuthEnv> {
  const dist = deps.distDirs ?? [join(deps.home, "dist"), join(process.cwd(), "dist")];
  const executor: ExecutorDeps = {
    home: deps.home,
    ownUrl: deps.ownUrl,
    transportFor: deps.transportFor ?? ((target) => sshTransport(target)),
    healthTimeoutMs: deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
  };
  const app = new Hono<AuthEnv>();
  app.use("*", requireInstanceAdmin);

  app.get("/requests", (c) => c.json(listRequests(db).map(view)));
  app.get("/requests/:id", (c) => {
    const found = getRequest(db, c.req.param("id"));
    return found ? c.json(view(found)) : notFound(c);
  });

  app.post("/requests", async (c) => {
    const body = await parseBody(c, createBody);
    if (body instanceof Response) return body;
    const target = await findTarget(deps.discovery, body.targetId);
    if (!target) return c.json({ error: "unknown_target" }, 404);
    if (target.kind === "docker") return c.json({ error: "docker_not_supported" }, 400);
    const binary = await resolveBinary(body.binary, dist);
    if (!binary) return c.json({ error: "binary_not_allowed" }, 400);
    const created = createRequest(db, {
      target,
      binaryPath: binary.path,
      binarySha256: binary.sha256,
      port: body.port ?? DEFAULT_PORT,
      requestedBy: c.get("actor").userId,
    });
    return c.json(view(created), 201);
  });

  app.post("/requests/:id/decide", requireStepUp, async (c) => {
    const body = await parseBody(c, decideBody);
    if (body instanceof Response) return body;
    const outcome = decide(db, c.req.param("id"), body.decision, c.get("actor").userId);
    if (outcome === "missing") return notFound(c);
    if (outcome === "conflict") return c.json({ error: "already_decided" }, 409);
    return c.json(view(getRequest(db, c.req.param("id")) as DeployRequest));
  });

  app.post("/requests/:id/run", (c) => {
    const id = c.req.param("id");
    const claimed = claimRun(db, id);
    if (claimed === "missing") return notFound(c);
    if (claimed === "conflict") return c.json({ error: "not_approved_or_already_started" }, 409);
    void runDeploy(db, getRequest(db, id) as DeployRequest, executor).catch((err: unknown) =>
      console.error("deploy bookkeeping failed", err),
    );
    return c.json(view(getRequest(db, id) as DeployRequest), 202);
  });
  return app;
}
