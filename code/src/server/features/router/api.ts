import type { Database } from "bun:sqlite";
import { route } from "./candidates";
import { startWatchdog } from "./failover";
import { estimateCostUsd, priceOf, refreshRegistry, registryStale } from "./registry";
import { startTriage, triageOf } from "./triage";

export { estimateCostUsd, priceOf, refreshRegistry, route, triageOf };

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
