import type { Database } from "bun:sqlite";
import { onTriaged } from "../router/api";
import { getRun, onRunEvent } from "../runtimes/api";
import { addEstimate, estimatesOf, priorFor, seedPrior } from "./estimates";
import { memberReport } from "./report";
import { recordRunStack } from "./stack";

export { addEstimate, estimatesOf, memberReport, priorFor };

export function startTracking(db: Database): () => void {
  const stopRuns = onRunEvent((runId, e) => {
    if (e.kind !== "run") return;
    const run = getRun(db, runId);
    if (!run) return;
    recordRunStack(db, run).catch((err: unknown) =>
      console.error("stack detection failed", runId, err instanceof Error ? err.message : err),
    );
  });
  const stopPriors = onTriaged((taskId) => seedPrior(db, taskId));
  return () => {
    stopRuns();
    stopPriors();
  };
}
