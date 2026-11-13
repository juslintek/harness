import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config";
import { ensureInstance, migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { version } from "../../version";

export const VERIFY_ONLY_ENV = "HARNESS_VERIFY_ONLY";

// The scratch verify runs the new binary on a copy of the live db. Anything beyond migrating and
// answering health would act on that copy's run pids, notify targets and instance identity.
export async function serveVerifyOnly(config: Config): Promise<number> {
  mkdirSync(config.home, { recursive: true });
  const db = openDb(join(config.home, "harness.db"));
  migrate(db, migrations);
  const instanceId = ensureInstance(db);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (req) =>
      new URL(req.url).pathname === "/api/health" && req.method === "GET"
        ? Response.json({ ok: true, instanceId, version })
        : new Response("verify only", { status: 404 }),
  });
  console.log(`harness listening on ${server.url}`);
  await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
  await server.stop();
  db.close();
  return 0;
}
