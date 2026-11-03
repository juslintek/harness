import type { Database } from "bun:sqlite";
import type { TaskType } from "../../../shared/router";

export interface StatRow {
  runtime: string;
  model: string | null;
  taskType: TaskType | null;
  runs: number;
  completed: number;
  medianMinutes: number | null;
  avgTokens: number | null;
}

interface RunFact {
  runtime: string;
  model: string | null;
  task_type: TaskType | null;
  state: string;
  started_at: number | null;
  ended_at: number;
  tokens: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function summarize(facts: RunFact[]): StatRow {
  const first = facts[0] as RunFact;
  const done = facts.filter((f) => f.state === "completed");
  const minutes = done.flatMap((f) =>
    f.started_at === null ? [] : [(f.ended_at - f.started_at) / 60_000],
  );
  const tokens = facts.flatMap((f) => (f.tokens === null ? [] : [f.tokens]));
  return {
    runtime: first.runtime,
    model: first.model,
    taskType: first.task_type,
    runs: facts.length,
    completed: done.length,
    medianMinutes: median(minutes),
    avgTokens: tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0) / tokens.length,
  };
}

// Runs without a triaged task still count, under a null task type.
export function learnedStats(db: Database, sinceMs: number): StatRow[] {
  const facts = db
    .query<RunFact, [number]>(
      `SELECT r.agent_id AS runtime, r.model, t.task_type, r.state, r.started_at, r.ended_at,
         (SELECT sum(COALESCE(e.gen_ai_usage_input_tokens, 0) + COALESCE(e.gen_ai_usage_output_tokens, 0))
          FROM events e WHERE e.run_id = r.id AND e.kind = 'usage') AS tokens
       FROM runs r LEFT JOIN task_triage t ON t.task_id = r.task_id
       WHERE r.ended_at IS NOT NULL AND r.created_at >= ?`,
    )
    .all(sinceMs);
  const groups = new Map<string, RunFact[]>();
  for (const f of facts) {
    const key = JSON.stringify([f.runtime, f.model, f.task_type]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map(summarize);
}
