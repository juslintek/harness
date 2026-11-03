import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./server/config";
import { ensureInstance, migrate, openDb } from "./server/db/db";
import { migrations } from "./server/db/migrations";
import { firstRunEnrollment } from "./server/features/auth/api";
import { wireBoard } from "./server/features/board/api";
import { startBudgets } from "./server/features/budgets/api";
import { wireChat } from "./server/features/chat/api";
import { startHeartbeat } from "./server/features/heartbeat/api";
import { startHiring } from "./server/features/hiring/api";
import { wireHiring } from "./server/features/hiring/wiring";
import { startRouter } from "./server/features/router/api";
import {
  recoverRuns,
  shutdownRuns,
  sweepStaleScratch,
  wireRuntimes,
} from "./server/features/runtimes/api";
import { startTracking } from "./server/features/tracking/api";
import { defaultTailSources, startTailers } from "./server/features/usage/api";
import { createApp, MAX_REQUEST_BODY_BYTES } from "./server/http";
import { pwaResponse } from "./server/pwa";
import { type WsData, websocket, wireRealtime } from "./server/realtime";
import indexHtml from "./web/index.html";

const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
const config = loadConfig();
mkdirSync(config.home, { recursive: true });

const db = openDb(join(config.home, "harness.db"));
migrate(db, migrations);
const instanceId = ensureInstance(db);
wireBoard(db);
wireChat(db);
wireRuntimes();

recoverRuns(db);
await sweepStaleScratch(config.home);
const app = createApp({
  db,
  home: config.home,
  port: config.port,
  rp: config.rp,
  trustProxy: config.trustProxy,
  instanceId,
  version: "0.0.0",
});
startTailers(db, 60000, defaultTailSources(join(config.home, "worktrees")));

const server = Bun.serve<WsData>({
  hostname: config.host,
  port: config.port,
  // The bundle lives on its own path so "/" can still reach the app and redirect the loopback IP.
  routes: { "/_app": indexHtml },
  fetch: (req, srv) => {
    const { pathname } = new URL(req.url);
    const pwa = pwaResponse(pathname);
    if (pwa) return pwa;
    const entry = pathname === "/";
    if (entry && req.headers.get("host") !== `127.0.0.1:${config.port}`) {
      return fetch(new URL("/_app", srv.url));
    }
    return app.fetch(req, { server: srv });
  },
  websocket,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  development: process.env.NODE_ENV !== "production",
});

wireRealtime(db, server);
const runDeps = { home: config.home, port: config.port };
const stopHeartbeat = startHeartbeat(db, { runDeps, home: config.home });
const hiring = wireHiring(db, { runDeps, home: config.home });
const stopLoops = [
  ...[startRouter, startBudgets, startTracking].map((start) => start(db)),
  startHiring(db, hiring.deps),
  hiring.stop,
];

console.log(`harness listening on ${server.url}`);

const firstRun = firstRunEnrollment(db, ENROLLMENT_TTL_MS);
if (firstRun) console.log(`first-run enrollment: ${config.rp.origin}/#/enroll/${firstRun}`);

// Agent groups are detached, so the terminal's Ctrl-C does not reach them.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const drained = stopHeartbeat();
    for (const stop of stopLoops) stop();
    shutdownRuns(db)
      .then(() => drained)
      .catch((err: unknown) => console.error("shutdown failed", err))
      .finally(() => {
        server.stop(true);
        process.exit(0);
      });
  });
}
