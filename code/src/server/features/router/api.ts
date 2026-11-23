import type { Database } from "bun:sqlite";
import { probeQuota } from "../usage/api";
import { pickAccountForRuntime } from "./accounts";
import { type RouteDeps, rankEngines, readyRuntimes, route, routeOutcome } from "./candidates";
import { linkRouteDecision, listRouteDecisions, pruneRouteDecisions } from "./decisions";
import {
  type FailoverDecision,
  linkHandoff,
  type NextAttempt,
  nextAttemptOrPark,
  startWatchdog,
} from "./failover";
import { handoffSummary } from "./handoff";
import { estimateCostUsd, priceOf, refreshRegistry, registryStale } from "./registry";
import { onTriaged, startTriage, triageOf } from "./triage";

export type { FailoverDecision, NextAttempt, RouteDeps };
export {
  estimateCostUsd,
  handoffSummary,
  linkHandoff,
  linkRouteDecision,
  listRouteDecisions,
  nextAttemptOrPark,
  onTriaged,
  priceOf,
  pruneRouteDecisions,
  rankEngines,
  readyRuntimes,
  refreshRegistry,
  route,
  routeOutcome,
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
  pruneRouteDecisions(db);
  if (registryStale(db, Date.now())) void refreshRegistry(db);
  const timer = setInterval(() => {
    pruneRouteDecisions(db);
    void refreshRegistry(db);
  }, REFRESH_EVERY_MS);
  timer.unref();
  return () => {
    stopTriage();
    stopWatchdog();
    clearInterval(timer);
  };
}
