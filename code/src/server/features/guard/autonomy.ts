import type { Database } from "bun:sqlite";
import { contextForMember, effective } from "../policies/api";
import type { L1Result } from "./rules-core";

export interface AutonomyView {
  value: "full" | "supervised" | "strict";
  layer: string;
}

// Read from the runs table because runtimes imports the guard, so the guard cannot import runtimes.
// A run with no member (an interview) has no org policy to apply.
export function autonomyOfRun(db: Database, runId: string): AutonomyView | null {
  const run = db
    .query<{ member_id: string | null; task_id: string | null }, [string]>(
      "SELECT member_id, task_id FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!run?.member_id) return null;
  const { value, layer } = effective(
    db,
    contextForMember(db, run.member_id, run.task_id ?? undefined),
    "autonomy",
  );
  return { value, layer };
}

// Policy only ever tightens the guard: a deny stays a deny and nothing becomes allow.
export function applyAutonomy(db: Database, runId: string, l1: L1Result): L1Result {
  if (l1.verdict !== "allow" || l1.category === "read") return l1;
  const autonomy = autonomyOfRun(db, runId);
  if (autonomy?.value !== "strict") return l1;
  return {
    ...l1,
    verdict: "ask",
    rule: "autonomy.strict",
    reason: `autonomy strict (${autonomy.layer})`,
  };
}
