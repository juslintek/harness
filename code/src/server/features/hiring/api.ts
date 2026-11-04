import type { Database } from "bun:sqlite";
import type { HireView } from "../../../shared/hiring";
import { type HireDigest, hireDigest } from "./digest";
import {
  advance,
  ask,
  candidateRunEnded,
  pass,
  recordAnswer,
  recordCardAnswer,
  score,
} from "./flow";
import { approverOf, decide, fileRequest, type HiringDeps } from "./hire";
import {
  candidateOfRun,
  getCandidate,
  getHire,
  interviewOpen,
  listHeads,
  openRequestIds,
  teamHasSpecialty,
  teamIdsOf,
} from "./repo";

export type { HireDigest, HiringDeps };
export {
  advance,
  approverOf,
  ask,
  candidateOfRun,
  candidateRunEnded,
  decide,
  fileRequest,
  getCandidate,
  getHire,
  hireDigest,
  interviewOpen,
  pass,
  recordAnswer,
  recordCardAnswer,
  score,
  teamIdsOf,
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
