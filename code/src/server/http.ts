import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { type Health, healthSchema } from "../shared/health";
import { searchQuerySchema, usageQuerySchema } from "../shared/query";
import { agentRoutes } from "./features/agents/routes";
import {
  hostGuard,
  mutationOriginGuard,
  originGuard,
  type Rp,
  requireInstanceAdmin,
  sessionMiddleware,
} from "./features/auth/api";
import { publicAuthRoutes } from "./features/auth/routes";
import { accountRoutes } from "./features/auth/routes-account";
import { boardRoutes } from "./features/board/routes";
import { chatRoutes } from "./features/chat/routes";
import { approvalRoutes } from "./features/guard/routes";
import { appendEvent, searchEvents } from "./features/logs/api";
import { mcpHandler, verifyRunToken } from "./features/mcp/api";
import { orgRoutes } from "./features/orgs/routes";
import { type RunDeps, refreshAcpModels } from "./features/runtimes/api";
import { haltRoutes, runRoutes } from "./features/runtimes/routes";
import { probeQuota, usageSummary } from "./features/usage/api";
import { wsUpgrade } from "./realtime";

// Applied by Bun.serve before any handler runs, so it also covers /mcp and the guard hook.
export const MAX_REQUEST_BODY_BYTES: number = 1024 * 1024;

export interface AppDeps {
  db: Database;
  home: string;
  port: number;
  rp: Rp;
  deliverEmailCode?: (email: string, code: string) => void | Promise<void>;
  instanceId: string;
  version: string;
  runDeps?: RunDeps;
}

const hookBody = z.object({
  runId: z.string().min(1),
  verdict: z.enum(["allow", "ask", "deny"]),
  rule: z.string().max(200),
  command: z.string().max(20000),
});

function bearer(header: string | undefined): string | null {
  return /^Bearer (\S+)$/.exec(header ?? "")?.[1] ?? null;
}

// The one /api route an agent may call: needs a run token scoped guard_hook, for its own run only.
function guardHook(db: Database): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const identity = token ? verifyRunToken(db, token) : null;
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (!identity.scopes.includes("guard_hook")) return c.json({ error: "forbidden" }, 403);
    const body = hookBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (body.data.runId !== identity.runId) return c.json({ error: "forbidden" }, 403);
    appendEvent(db, {
      kind: "guard",
      source: "hook",
      runId: body.data.runId,
      command: body.data.command,
      guardVerdict: body.data.verdict,
      guardRule: body.data.rule,
    });
    return c.json({ ok: true });
  });
  return app;
}

function adminRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const runDeps = deps.runDeps ?? { home: deps.home, port: deps.port };
  const app = new Hono();
  for (const path of ["/runs", "/approvals", "/halt", "/agents", "/search", "/usage", "/quota"]) {
    app.use(`${path}/*`, requireInstanceAdmin);
  }
  app.route("/runs", runRoutes(db, runDeps));
  app.route("/approvals", approvalRoutes(db));
  app.route("/halt", haltRoutes(db));
  app.route("/agents", agentRoutes(db, { listAcp: (spec) => refreshAcpModels(runDeps, spec) }));
  app.get("/search", (c) => {
    const query = searchQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid query" }, 400);
    return c.json(searchEvents(db, query.data.q));
  });
  app.get("/usage", (c) => {
    const query = usageQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "invalid query" }, 400);
    return c.json(usageSummary(db, query.data.by, query.data.since));
  });
  app.get("/quota", async (c) => c.json(await probeQuota(db)));
  return app;
}

export function createApp(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();
  app.use(secureHeaders());
  // The browser entry on the loopback IP cannot sign in (WebAuthn refuses IP RP IDs), so send it on.
  app.get("/", (c, next) =>
    c.req.header("host") === `127.0.0.1:${deps.port}` ? c.redirect(deps.rp.origin) : next(),
  );
  app.use(hostGuard(deps.rp.origin, deps.port));
  app.get("/api/health", (c) => {
    const body: Health = healthSchema.parse({
      ok: true,
      instanceId: deps.instanceId,
      version: deps.version,
    });
    return c.json(body);
  });
  const mcp = mcpHandler(
    db,
    (runId, text) => appendEvent(db, { kind: "message", source: "mcp", runId, body: text }),
    deps.port,
  );
  app.all("/mcp", (c) => mcp(c.req.raw));
  app.route("/api/guard/hook", guardHook(db));
  app.use("/api/*", mutationOriginGuard(deps.rp.origin));
  app.route(
    "/api/auth",
    publicAuthRoutes({
      db,
      rp: deps.rp,
      deliverEmailCode:
        deps.deliverEmailCode ?? ((email, code) => console.log(`email code for ${email}: ${code}`)),
    }),
  );
  app.use("/api/*", sessionMiddleware(db));
  app.route("/api/auth", accountRoutes(db, deps.rp));
  app.route("/api", orgRoutes({ db, origin: deps.rp.origin }));
  app.route("/api", boardRoutes(db));
  app.route("/api", chatRoutes(db));
  app.route("/api", adminRoutes(deps));
  app.use("/ws", sessionMiddleware(db), originGuard(deps.rp.origin));
  app.get("/ws", wsUpgrade(db));
  return app;
}
