import type { Database } from "bun:sqlite";
import { budgetGate } from "../budgets/api";
import { wakeFor } from "../heartbeat/api";
import { rankEngines, readyRuntimes } from "../router/api";
import type { HiringDeps } from "./hire";
import { type InterviewEnv, runInterview } from "./interview";

const READY_REFRESH_MS = 60_000;

// Kept apart from hiring/api.ts: it needs runtimes and the router, and the mcp tools that import
// hiring/api are themselves reachable from runtimes.
export function wireHiring(
  db: Database,
  env: InterviewEnv,
): { deps: HiringDeps; stop: () => void } {
  // engineReady is read inside synchronous scoring, so it reads the last answer of an async probe.
  let ready = new Set<string>();
  const refresh = (): void => {
    readyRuntimes(db).then(
      (runtimes) => {
        ready = runtimes;
      },
      (err: unknown) => console.error("hiring: runtime probe failed", err),
    );
  };
  refresh();
  const timer = setInterval(refresh, READY_REFRESH_MS);
  timer.unref();
  const deps: HiringDeps = {
    // A role has no difficulty of its own; medium keeps the ranking from favouring either extreme.
    pickEngines: async ({ orgId, spec, max }) =>
      (
        await rankEngines(db, { orgId, difficulty: "medium", taskType: spec.taskTypes[0] ?? null })
      ).slice(0, max),
    engineReady: (engine) => ready.has(engine.runtime),
    budgetPaused: (memberId) => budgetGate(db, memberId).state === "paused",
    startInterview: (candidateId, questionIds) => {
      runInterview(db, env, deps, candidateId, questionIds).catch((err: unknown) =>
        console.error("hiring: interview crashed", candidateId, err),
      );
    },
    wake: (memberId, reason, detail, causedBy) => wakeFor(db, memberId, reason, detail, causedBy),
  };
  return { deps, stop: () => clearInterval(timer) };
}
