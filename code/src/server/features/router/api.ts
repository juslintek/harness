import type { Database } from "bun:sqlite";
import { probeQuota } from "../usage/api";
import { pickAccountForRuntime } from "./accounts";
import { type RouteDeps, rankEngines, readyRuntimes, route } from "./candidates";
import { linkHandoff, type NextAttempt, nextAttempt, startWatchdog } from "./failover";
import { estimateCostUsd, priceOf, refreshRegistry, registryStale } from "./registry";
import { onTriaged, startTriage, triageOf } from "./triage";

export type { NextAttempt, RouteDeps };
export {
  estimateCostUsd,
  linkHandoff,
  nextAttempt,
  onTriaged,
  priceOf,
  rankEngines,
  readyRuntimes,
  refreshRegistry,
  route,
  startWatchdog,
  triageOf,
};

export async function pickAccount(db: Database, runtime: string): Promise<string | null> {
  return pickAccountForRuntime(db, runtime, await probeQuota(db));
}

const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;

export function startRouter(db: Database): () => void {
  const stopTriage = startTriage(db);
  const stopWatchdog = startWatchdog(db);
  if (registryStale(db, Date.now())) void refreshRegistry(db);
  const timer = setInterval(() => void refreshRegistry(db), REFRESH_EVERY_MS);
  timer.unref();
  return () => {
    stopTriage();
    stopWatchdog();
    clearInterval(timer);
  };
}
