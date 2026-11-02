import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./server/config";
import { ensureInstance, migrate, openDb } from "./server/db/db";
import { migrations } from "./server/db/migrations";
import { ensureAdminSecret } from "./server/features/auth/api";
import { startTailers } from "./server/features/usage/api";
import { createApp } from "./server/http";
import indexHtml from "./web/index.html";

const config = loadConfig();
mkdirSync(config.home, { recursive: true });

const db = openDb(join(config.home, "harness.db"));
migrate(db, migrations);
const instanceId = ensureInstance(db);

const secret = ensureAdminSecret(config.home);
const app = createApp({
  db,
  home: config.home,
  port: config.port,
  secret,
  instanceId,
  version: "0.0.0",
});
startTailers(db);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  routes: { "/": indexHtml },
  fetch: app.fetch,
  maxRequestBodySize: 1024 * 1024,
  development: process.env.NODE_ENV !== "production",
});

console.log(`harness listening on ${server.url}`);
console.log(`admin login: http://127.0.0.1:${config.port}/login?k=${secret}`);
