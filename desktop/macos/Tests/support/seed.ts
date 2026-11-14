// Run with bun: bun seed.ts <home dir>. Writes the user and session into harness.db before the server
// opens it, the way the conformance suite does.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations, openSeedDb, seedSession } from "../../../../code/conformance/kit/seed.ts";

const home = process.argv[2];
if (!home) throw new Error("usage: seed.ts <home dir>");
mkdirSync(home, { recursive: true });
const db = openSeedDb(join(home, "harness.db"));
applyMigrations(db);
const { userId, cookie } = seedSession(db, { admin: true, stepUp: true });
db.close();
console.log(JSON.stringify({ userId, cookie }));
