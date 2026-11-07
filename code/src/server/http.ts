import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { type Health, healthSchema } from "../shared/health";
import { searchQuerySchema, usageQuerySchema } from "../shared/query";
import { quotaBodySchema } from "../shared/router";
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
import { bridgeRoutes } from "./features/bridge/api";
import { budgetGate } from "./features/budgets/api";
import { budgetsRoutes } from "./features/budgets/routes";
import { chatRoutes } from "./features/chat/routes";
import { approvalRoutes } from "./features/guard/routes";
import { wakeRoutes } from "./features/heartbeat/routes";
import { hiringRoutes } from "./features/hiring/routes";
import { integrationRoutes } from "./features/integrations/api";
import { appendEvent, searchEvents } from "./features/logs/api";
import { logsRoutes } from "./features/logs/routes";
import { type McpDeps, mcpHandler, remoteMcpHandler, verifyRunToken } from "./features/mcp/api";
import { memoryRoutes } from "./features/memory/routes";
import { notifyRoutes } from "./features/notify/api";
import { consentRoutes, grantRoutes, oauthPublicRoutes } from "./features/oauth/api";
import { orgRoutes } from "./features/orgs/routes";
import { harnessPolicyRoutes, policiesRoutes } from "./features/policies/routes";
import { profilesRoutes } from "./features/profiles/routes";
import { routerRoutes } from "./features/router/routes";
import { type RunDeps, refreshAcpModels } from "./features/runtimes/api";
import { haltRoutes, runRoutes } from "./features/runtimes/routes";
import { addEstimate, taskTrackingFields } from "./features/tracking/api";
import { trackingRoutes } from "./features/tracking/routes";
import { createTunnel, type Tunnel, tunnelRoutes } from "./features/tunnel/api";
import { probeQuota, recordQuota, usageSummary } from "./features/usage/api";
import { wsUpgrade } from "./realtime";
import { parseBody } from "./route-kit";

// Applied by Bun.serve before any handler runs, so it also covers /mcp and the guard hook.
export const MAX_REQUEST_BODY_BYTES: number = 1024 * 1024;

export interface AppDeps {
  db: Database;
  home: string;
  port: number;
  rp: Rp;
  trustProxy?: boolean;
  deliverEmailCode?: (email: string, code: string) => void | Promise<void>;
  instanceId: string;
  version: string;
  runDeps?: RunDeps;
  // Owned by the caller when it must stop the child process on shutdown.
  tunnel?: Tunnel;
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
  for (const path of [
    "/runs",
    "/halt",
    "/agents",
    "/search",
    "/usage",
    "/quota",
    "/router",
    "/policies",
    "/tunnel",
    "/integrations",
  ]) {
    app.use(`${path}/*`, requireInstanceAdmin);
  }
  app.route("/runs", runRoutes(db, runDeps));
  app.route("/approvals", approvalRoutes(db, deps.home));
  app.route("/halt", haltRoutes(db));
  app.route(
    "/tunnel",
    tunnelRoutes(deps.tunnel ?? createTunnel({ home: deps.home, port: deps.port }), deps.home),
  );
  app.route("/integrations", integrationRoutes(db, deps.home));
  app.route("/router", routerRoutes(db));
  app.route("/policies", harnessPolicyRoutes(db));
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
  app.post("/quota", async (c) => {
    const body = await parseBody(c, quotaBodySchema);
    if (body instanceof Response) return body;
    recordQuota(db, { ...body, resetsAt: body.resetsAt ?? null, source: "manual" });
    return c.json({ ok: true });
  });
  return app;
}

const trackingPort: McpDeps["tracking"] = {
  addEstimate,
  taskFields: taskTrackingFields,
  budgetState: (d, memberId) => budgetGate(d, memberId).state,
};

function mountMcp(app: Hono, deps: AppDeps): void {
  const mcp = mcpHandler(
    deps.db,
    {
      harnessHome: deps.home,
      tracking: trackingPort,
      onReport: (runId, text) =>
        appendEvent(deps.db, { kind: "message", source: "mcp", runId, body: text }),
    },
    deps.port,
  );
  app.all("/mcp", (c) => mcp(c.req.raw));
  // Not in LOOPBACK_PATHS: only the configured origin host reaches it. Bearer-token calls carry no
  // cookie, and mutationOriginGuard only covers /api.
  const remote = remoteMcpHandler(
    deps.db,
    { harnessHome: deps.home, tracking: trackingPort },
    deps.rp.origin,
  );
  app.all("/mcp/remote", (c) => remote(c.req.raw));
}

// Public: discovery, registration and the token endpoint carry no cookie, so no Origin check
// applies, but hostGuard above still does. Consent and deny act on the signed-in human's cookie,
// so they get the same Origin check as /api mutations.
function mountOauth(app: Hono, deps: AppDeps): void {
  const { db } = deps;
  const oauth = { db, origin: deps.rp.origin };
  app.route("/", oauthPublicRoutes(oauth));
  for (const path of ["/oauth/consent", "/oauth/deny"]) {
    app.use(path, mutationOriginGuard(deps.rp.origin), sessionMiddleware(db, deps.rp.origin));
  }
  app.route("/oauth", consentRoutes(db, deps.rp.origin, Date.now));
}

function mountSessionRoutes(app: Hono, deps: AppDeps): void {
  const { db } = deps;
  app.use("/api/*", sessionMiddleware(db, deps.rp.origin));
  app.route("/api/auth", accountRoutes(db, deps.rp));
  app.route("/api", orgRoutes({ db, origin: deps.rp.origin }));
  app.route("/api", boardRoutes(db));
  app.route("/api", chatRoutes(db));
  app.route("/api", wakeRoutes(db));
  app.route("/api", profilesRoutes(db));
  app.route("/api", policiesRoutes(db));
  app.route("/api", hiringRoutes(db));
  app.route("/api", budgetsRoutes(db));
  app.route("/api", trackingRoutes(db));
  app.route("/api", memoryRoutes(db, deps.home));
  app.route("/api", logsRoutes(db));
  app.route("/api/notify", notifyRoutes(db, deps.home));
  app.route("/api/bridge", bridgeRoutes(db));
  app.route("/api/oauth", grantRoutes(db, Date.now));
  app.route("/api", adminRoutes(deps));
}

export function consoleEmailCode(email: string, code: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("email code delivery unavailable: SMTP is not configured");
  }
  console.log(`email code for ${email}: ${code}`);
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
  mountMcp(app, deps);
  app.route("/api/guard/hook", guardHook(db));
  mountOauth(app, deps);
  app.use("/api/*", mutationOriginGuard(deps.rp.origin));
  app.route(
    "/api/auth",
    publicAuthRoutes({
      db,
      rp: deps.rp,
      ...(deps.trustProxy === undefined ? {} : { trustProxy: deps.trustProxy }),
      deliverEmailCode: deps.deliverEmailCode ?? consoleEmailCode,
    }),
  );
  mountSessionRoutes(app, deps);
  app.use("/ws", sessionMiddleware(db), originGuard(deps.rp.origin));
  app.get("/ws", wsUpgrade(db));
  return app;
}
