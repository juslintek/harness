import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import type { Config } from "../../config";
import type { AuthEnv } from "../auth/api";
import { failInterrupted } from "./requests";
import { pipelineRoutes } from "./routes";
import { DEFAULT_STEPS } from "./steps";
import { parseSwapArgs, swap } from "./swap";
import { serveVerifyOnly, VERIFY_ONLY_ENV } from "./verify-only";

export interface SelfupdateDeps {
  home: string;
}

const VERIFY_MS = 30_000;

export function selfupdateRoutes(
  db: Database,
  live: { home: string; port: number },
): Hono<AuthEnv> {
  return pipelineRoutes(db, {
    ...live,
    pid: process.pid,
    liveBinary: process.execPath,
    steps: DEFAULT_STEPS,
    // The normal signal handler in main.ts drains everything in order.
    beginShutdown: () => process.kill(process.pid, "SIGTERM"),
    verifyMs: VERIFY_MS,
  });
}

export function startSelfupdate(db: Database, _deps: SelfupdateDeps): () => Promise<void> {
  failInterrupted(db);
  return async () => {};
}

export async function runSwapCli(args: string[]): Promise<number> {
  try {
    return (await swap(parseSwapArgs(args))) === "done" ? 0 : 1;
  } catch (err) {
    console.error("swap failed", err);
    return 2;
  }
}

export function verifyOnlyRequested(): boolean {
  return process.env[VERIFY_ONLY_ENV] === "1";
}

export function runVerifyOnly(config: Config): Promise<number> {
  return serveVerifyOnly(config);
}
