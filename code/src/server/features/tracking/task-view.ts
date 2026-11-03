import type { Database } from "bun:sqlite";
import { triageOf } from "../router/api";
import { estimatesOf, priorFor } from "./estimates";

// What an agent sees of a task's sizing: the triage, the human-minute prior for its size, and every estimate.
export function taskTrackingFields(db: Database, taskId: string): Record<string, unknown> {
  const triage = triageOf(db, taskId);
  const prior = priorFor(db, taskId);
  return {
    ...(triage
      ? {
          triage: {
            difficulty: triage.difficulty,
            type: triage.taskType,
            specialty: triage.specialty,
            size: triage.size,
          },
        }
      : {}),
    ...(prior === null ? {} : { prior: `${prior} min` }),
    estimates: estimatesOf(db, taskId).map((e) => ({
      kind: e.kind,
      minutes: e.minutes,
      source: e.source,
      rationale: e.rationale,
    })),
  };
}
