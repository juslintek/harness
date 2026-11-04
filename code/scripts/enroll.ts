import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "../src/server/config";
import { migrate, openDb } from "../src/server/db/db";
import { migrations } from "../src/server/db/migrations";
import { createEnrollment, createUser, findUserByEmail } from "../src/server/features/auth/api";

const TTL_MS = 24 * 60 * 60 * 1000;

// An existing user keeps their account and only adds a passkey (lost device, lost recovery codes);
// an unknown email gets an account first so the name given here is the one that is kept.
export function enrollLink(
  db: Database,
  origin: string,
  who: { email: string; name?: string | undefined },
): string {
  const existing = findUserByEmail(db, who.email);
  const userId =
    existing?.id ??
    createUser(db, {
      email: who.email,
      name: who.name ?? who.email.split("@")[0] ?? who.email,
      instanceAdmin: false,
    });
  return `${origin}/#/enroll/${createEnrollment(db, { userId, ttlMs: TTL_MS })}`;
}

// With HARNESS_PORT=0 the server only learns its port after binding, so a link built here would
// point at port 0.
export function linkOrigin(config: Config, env: Record<string, string | undefined>): string {
  if (config.port === 0 && !env.HARNESS_ORIGIN) {
    throw new Error(
      "HARNESS_PORT=0 has no fixed origin: set HARNESS_ORIGIN or a real HARNESS_PORT",
    );
  }
  return config.rp.origin;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  if (!values.email) {
    console.error("usage: bun scripts/enroll.ts --email <email> [--name <name>]");
    process.exit(1);
  }
  const config = loadConfig();
  let origin: string;
  try {
    origin = linkOrigin(config, process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  mkdirSync(config.home, { recursive: true });
  const db = openDb(join(config.home, "harness.db"));
  migrate(db, migrations);
  console.log(enrollLink(db, origin, { email: values.email, name: values.name }));
}
