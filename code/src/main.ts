import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./server/config";
import { ensureInstance, migrate, openDb } from "./server/db/db";
import { migrations } from "./server/db/migrations";
import { createApp } from "./server/http";
import indexHtml from "./web/index.html";

const config = loadConfig();
mkdirSync(config.home, { recursive: true });

const db = openDb(join(config.home, "harness.db"));
migrate(db, migrations);
const instanceId = ensureInstance(db);

const app = createApp({ instanceId, version: "0.0.0" });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  routes: { "/": indexHtml },
  fetch: app.fetch,
  development: process.env.NODE_ENV !== "production",
});

console.log(`harness listening on ${server.url}`);
