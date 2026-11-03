import type { Database } from "bun:sqlite";
import { estimateCostUsd, priceOf, refreshRegistry, registryStale } from "./registry";
import { onTriaged, startTriage, triageOf } from "./triage";

export { estimateCostUsd, onTriaged, priceOf, refreshRegistry, triageOf };

const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;

export function startRouter(db: Database): () => void {
  const stopTriage = startTriage(db);
  if (registryStale(db, Date.now())) void refreshRegistry(db);
  const timer = setInterval(() => void refreshRegistry(db), REFRESH_EVERY_MS);
  timer.unref();
  return () => {
    stopTriage();
    clearInterval(timer);
  };
}
