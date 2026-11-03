import type { Database } from "bun:sqlite";
import type { Scorecard } from "../../../shared/hiring";
import { getProfile } from "../profiles/api";
import type { HiringDeps } from "./hire";
import { questionProgress, scorecardsOf } from "./interview-repo";
import { candidatesOf, type HireHead, setCandidateScores } from "./repo";

export interface SystemInput {
  card: boolean;
  answeredFraction: number;
  specialty: boolean;
  engineReady: boolean;
}

// 0..5. Most of the weight sits on what the candidate did in the interview, a little on whether it can run at all.
export function systemScore(i: SystemInput): number {
  return (
    5 *
    (0.3 * Number(i.card) +
      0.3 * i.answeredFraction +
      0.3 * Number(i.specialty) +
      0.1 * Number(i.engineReady))
  );
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// Without any reviewer scorecard the system score stands alone, so a team with no agents can still hire.
function totalScore(system: number, cards: Scorecard[]): number {
  if (cards.length === 0) return system;
  const reviewers = mean(cards.map((c) => mean([c.fit, c.depth, c.honesty])));
  return 0.6 * reviewers + 0.4 * system;
}

export function computeTotals(db: Database, deps: HiringDeps, head: HireHead): void {
  for (const c of candidatesOf(db, head.id).filter((c) => c.status !== "failed")) {
    const profile = getProfile(db, c.profileId);
    const card = profile?.card ?? null;
    const progress = questionProgress(db, head.id, c.id);
    const system = systemScore({
      card: card !== null,
      answeredFraction: progress.total === 0 ? 0 : progress.answered / progress.total,
      specialty: card?.specialties.includes(head.spec.specialty) ?? false,
      engineReady: profile
        ? deps.engineReady({ runtime: profile.runtime, model: profile.model })
        : false,
    });
    setCandidateScores(db, c.id, system, totalScore(system, scorecardsOf(db, c.id)));
  }
}
