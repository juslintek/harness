import type { Difficulty, Engine } from "../../../shared/router";
import type { Price } from "./registry";
import type { StatRow } from "./stats";

export interface ScoreInput {
  engine: Engine;
  primary: boolean;
  triage: { difficulty: Difficulty } | null;
  price: Price | null;
  // Share of the provider's quota still free, 0..1; null when the provider reports none.
  headroom: number | null;
  stat: StatRow | null;
}

const NEED: Readonly<Record<Difficulty, number>> = { easy: 1, medium: 2, hard: 3 };
const HIGH_OUTPUT_USD = 30;
const MID_OUTPUT_USD = 8;
// Blended USD per million tokens at which an engine counts as fully expensive.
const COST_CEILING_USD = 60;

// Output price is the best signal the registry gives for how capable a model is.
export function tierOf(price: Price | null): number {
  if (!price) return 2;
  if (price.output >= HIGH_OUTPUT_USD) return 3;
  return price.output >= MID_OUTPUT_USD ? 2 : 1;
}

function fitOf(tier: number, need: number): number {
  return tier >= need ? 1 - 0.15 * (tier - need) : 1 - 0.5 * (need - tier);
}

function costOf(price: Price | null): number {
  if (!price) return 0.5;
  return 1 - Math.min(1, (0.75 * price.input + 0.25 * price.output) / COST_CEILING_USD);
}

export function scoreEngine(input: ScoreInput): number {
  const need = input.triage ? NEED[input.triage.difficulty] : 2;
  const fit = fitOf(tierOf(input.price), need);
  const head = input.headroom ?? 0.5;
  const learned = input.stat ? (input.stat.completed + 1) / (input.stat.runs + 2) : 0.5;
  return (
    0.35 * fit +
    0.25 * head +
    0.15 * costOf(input.price) +
    0.2 * learned +
    0.05 * (input.primary ? 1 : 0)
  );
}
