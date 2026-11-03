import type { Database } from "bun:sqlite";
import type { HireView } from "../../../shared/hiring";
import { advance, ask, candidateRunEnded, pass, recordAnswer, score } from "./flow";
import { decide, fileRequest, type HiringDeps } from "./hire";
import { candidateOfRun, getHire, listHeads, openRequestIds, teamHasSpecialty } from "./repo";

export type { HiringDeps };
export {
  advance,
  ask,
  candidateOfRun,
  candidateRunEnded,
  decide,
  fileRequest,
  getHire,
  pass,
  recordAnswer,
  score,
};

const TICK_MS = 60_000;

let active: HiringDeps | null = null;

// Routes act with the deps the process started with; a bare createApp (tests) has none.
export function hiringDeps(): HiringDeps | null {
  return active;
}

export function listHires(db: Database, orgId: string): HireView[] {
  return listHeads(db, orgId).flatMap((h) => getHire(db, h.id) ?? []);
}

export function teamLacks(db: Database, teamId: string, specialty: string): boolean {
  return !teamHasSpecialty(db, teamId, specialty);
}

// A null tick only registers the deps, for tests that drive the flow by hand.
export function startHiring(
  db: Database,
  deps: HiringDeps,
  tickMs: number | null = TICK_MS,
): () => void {
  active = deps;
  if (tickMs === null)
    return () => {
      active = null;
    };
  const timer = setInterval(() => {
    for (const id of openRequestIds(db)) {
      try {
        advance(db, deps, id);
      } catch (err) {
        console.error("hiring tick failed", id, err);
      }
    }
  }, tickMs);
  return () => {
    clearInterval(timer);
    active = null;
  };
}
