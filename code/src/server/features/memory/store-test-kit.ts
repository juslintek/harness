import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { drainCommits } from "./git-log";
import { loc, testDb, viewer } from "./index-test-kit";
import type { Located, Viewer } from "./paths";
import type { WriteCtx } from "./store-kit";

export interface Env {
  db: Database;
  dir: string;
}

export function setup(): Env {
  const { db, dir } = testDb();
  return { db, dir };
}

export async function teardown(env: Env): Promise<void> {
  await drainCommits();
  env.db.close();
  rmSync(env.dir, { recursive: true, force: true });
}

export function ctx(v: Viewer, runId: string | null = null): WriteCtx {
  return { viewer: v, runId };
}

export const aliceA: Viewer = { ...viewer("A", "m1", ["pa"]), actor: "alice" };
export const bobB: Viewer = { ...viewer("B", "m9", ["pb"]), actor: "bob" };
export const orgNote: Located = loc("orgs/A/org/deploy.md");
