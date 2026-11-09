import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./server/config";
import { ensureInstance, lockHome, migrate, openDb } from "./server/db/db";
import { migrations } from "./server/db/migrations";
import { firstRunEnrollment } from "./server/features/auth/api";
import { wireBoard } from "./server/features/board/api";
import { startBridges } from "./server/features/bridge/api";
import { startBudgets } from "./server/features/budgets/api";
import { wireChat } from "./server/features/chat/api";
import { startDeploy } from "./server/features/deploy/api";
import { consumePairInvite, startFederation } from "./server/features/federation/api";
import { startHeartbeat } from "./server/features/heartbeat/api";
import { startHiring } from "./server/features/hiring/api";
import { wireHiring } from "./server/features/hiring/wiring";
import { startMemory } from "./server/features/memory/api";
import { emailCodeSender, startNotify } from "./server/features/notify/api";
import { startRouter } from "./server/features/router/api";
import {
  recoverRuns,
  shutdownRuns,
  sweepStaleScratch,
  wireRuntimes,
} from "./server/features/runtimes/api";
import {
  runSwapCli,
  runVerifyOnly,
  startSelfupdate,
  verifyOnlyRequested,
} from "./server/features/selfupdate/api";
import { startTracking } from "./server/features/tracking/api";
import { createTunnel } from "./server/features/tunnel/api";
import { defaultTailSources, startTailers } from "./server/features/usage/api";
import { consoleEmailCode, MAX_REQUEST_BODY_BYTES } from "./server/http";
import { createOriginApp } from "./server/origin-app";
import { closeRealtimeSockets, type WsData, websocket, wireRealtime } from "./server/realtime";
import { drainStops } from "./server/shutdown";
import { staticResponse } from "./server/ui-dist";
import { version } from "./server/version";
import indexHtml from "./web/index.html";

const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
// The swap helper is this same binary started with a subcommand; it must not boot a server.
if (Bun.argv[2] === "swap") process.exit(await runSwapCli(Bun.argv.slice(3)));
const config = loadConfig();
// The scratch verify of a new binary: migrate and answer health, start nothing else.
if (verifyOnlyRequested()) process.exit(await runVerifyOnly(config));
const uiDist = process.env.HARNESS_UI_DIST;
mkdirSync(config.home, { recursive: true });
lockHome(config.home);

const db = openDb(join(config.home, "harness.db"));
migrate(db, migrations);
const instanceId = ensureInstance(db);
// Before the server listens, so a deployer that sees /api/health can already pair.
consumePairInvite(db, config.home);
wireBoard(db);
wireChat(db);
wireRuntimes();

recoverRuns(db);
await sweepStaleScratch(config.home);

// With HARNESS_PORT=0 the real port is only known after binding, and the origin and run deps derive from it.
let app: ReturnType<typeof createOriginApp>;
const server = Bun.serve<WsData>({
  hostname: config.host,
  port: config.port,
  // The bundle lives on its own path so "/" can still reach the app and redirect the loopback IP.
  routes: uiDist ? {} : { "/_app": indexHtml },
  fetch: async (req, srv) => {
    const { pathname } = new URL(req.url);
    const asset = await staticResponse(uiDist, req.method, pathname);
    if (asset) return asset;
    const entry = pathname === "/";
    if (entry && req.headers.get("host") !== `127.0.0.1:${srv.port}`) {
      return fetch(new URL("/_app", srv.url));
    }
    return app.fetch(req, { server: srv });
  },
  websocket,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  development: process.env.NODE_ENV !== "production",
});

const bound =
  config.port === 0 ? loadConfig({ ...process.env, HARNESS_PORT: `${server.port}` }) : config;
const tunnel = createTunnel({ home: bound.home, port: bound.port });
const currentOrigin = (): string =>
  (process.env.HARNESS_ORIGIN ? new URL(process.env.HARNESS_ORIGIN).origin : undefined) ??
  tunnel.origin() ??
  `http://localhost:${bound.port}`;
app = createOriginApp(
  {
    db,
    home: bound.home,
    port: bound.port,
    rp: bound.rp,
    trustProxy: bound.trustProxy,
    // Resolved per request, so saving SMTP settings applies without a restart.
    deliverEmailCode: (email, code) =>
      (emailCodeSender(db, bound.home) ?? consoleEmailCode)(email, code),
    instanceId,
    version,
    tunnel,
  },
  currentOrigin,
);
startTailers(db, 60000, defaultTailSources(join(config.home, "worktrees")));

wireRealtime(db, server);
const runDeps = { home: bound.home, port: bound.port };
const stopHeartbeat = startHeartbeat(db, { runDeps, home: config.home });
const hiring = wireHiring(db, { runDeps, home: config.home });
const stopMemory = startMemory(db, { home: config.home });
const stopLoops = [
  ...[startRouter, startBudgets, startTracking].map((start) => start(db)),
  startHiring(db, hiring.deps),
  hiring.stop,
  startNotify(db, { home: config.home, origin: currentOrigin }),
  startBridges(db, { home: config.home, origin: currentOrigin() }),
  ...[startFederation, startDeploy, startSelfupdate].map((start) =>
    start(db, { home: config.home }),
  ),
];

console.log(`harness listening on ${server.url}`);

const firstRun = firstRunEnrollment(db, ENROLLMENT_TTL_MS);
if (firstRun) console.log(`first-run enrollment: ${currentOrigin()}/#/enroll/${firstRun}`);

// Agent groups are detached, so the terminal's Ctrl-C does not reach them.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    tunnel.beginShutdown();
    const serverDrain = server.stop();
    closeRealtimeSockets();
    const drained = stopHeartbeat();
    // The server stops before memory drains so no API write lands after the last commit is flushed;
    // a failed step is logged and the later ones still run.
    const step = (run: () => unknown) =>
      Promise.resolve()
        .then(run)
        .catch((err: unknown) => console.error("shutdown failed", err));
    const loopsDrained = drainStops(stopLoops, (err) => console.error("shutdown failed", err));
    const stopTunnel = step(async () => {
      const result = await tunnel.stop();
      if (!result.ok) throw new Error(result.error);
    });
    step(() => serverDrain)
      .then(() => stopTunnel)
      .then(() => step(() => shutdownRuns(db)))
      .then(() => step(() => drained))
      .then(() => loopsDrained)
      .then(() => step(stopMemory))
      .finally(() => process.exit(0));
  });
}
