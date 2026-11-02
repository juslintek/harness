import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./server/config";
import { ensureInstance, migrate, openDb } from "./server/db/db";
import { migrations } from "./server/db/migrations";
import { firstRunEnrollment } from "./server/features/auth/api";
import { wireBoard } from "./server/features/board/api";
import { recoverRuns, shutdownRuns } from "./server/features/runtimes/api";
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

recoverRuns(db);
const app = createApp({
  db,
  home: config.home,
  port: config.port,
  rp: config.rp,
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

console.log(`harness listening on ${server.url}`);

const firstRun = firstRunEnrollment(db, ENROLLMENT_TTL_MS);
if (firstRun) console.log(`first-run enrollment: ${config.rp.origin}/#/enroll/${firstRun}`);

// Agent groups are detached, so the terminal's Ctrl-C does not reach them.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    shutdownRuns(db)
      .catch((err: unknown) => console.error("shutdown failed", err))
      .finally(() => {
        server.stop(true);
        process.exit(0);
      });
  });
}
