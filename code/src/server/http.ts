import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { type Health, healthSchema } from "../shared/health";
import { searchQuerySchema, usageQuerySchema } from "../shared/query";
import { agentRoutes } from "./features/agents/routes";
import { adminMiddleware, hostGuard, loginHandler } from "./features/auth/api";
import { appendEvent, searchEvents } from "./features/logs/api";
import { mcpHandler, verifyRunToken } from "./features/mcp/api";
import { probeQuota, usageSummary } from "./features/usage/api";

export interface AppDeps {
  db: Database;
  home: string;
  port: number;
  secret: string;
  instanceId: string;
  version: string;
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

function adminRoutes(db: Database): Hono {
  const app = new Hono();
  app.route("/agents", agentRoutes(db));
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
  app.use(hostGuard(deps.port));
  app.get("/login", loginHandler(deps.secret));
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
  app.use("/api/*", adminMiddleware(deps.secret, deps.port));
  app.route("/api", adminRoutes(db));
  return app;
}
