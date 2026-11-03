import { expect, test } from "bun:test";
import { migrate, openDb } from "../../db/db";
import { migrations } from "../../db/migrations";
import { appendEvent } from "../logs/api";
import { learnedStats } from "./stats";

test("learnedStats counts ended runs, takes the median minutes of completed ones and averages tokens", () => {
  const db = openDb(":memory:");
  migrate(db, migrations);
  const insert = (id: string, state: string, endedAt: number | null): void => {
    db.run(
      `INSERT INTO runs (id, agent_id, model, repo, prompt, state, created_at, started_at, ended_at)
       VALUES (?, 'claude', 'opus', 'r', 'p', ?, ?, 0, ?)`,
      [id, state, Date.now(), endedAt],
    );
  };
  insert("a", "completed", 60_000);
  insert("b", "completed", 180_000);
  insert("c", "failed", 600_000);
  insert("live", "running", null);
  appendEvent(db, { kind: "usage", runId: "a", inputTokens: 100, outputTokens: 50 });
  appendEvent(db, { kind: "usage", runId: "c", inputTokens: 10, outputTokens: 10 });
  expect(learnedStats(db, 0)).toEqual([
    {
      runtime: "claude",
      model: "opus",
      taskType: null,
      runs: 3,
      completed: 2,
      medianMinutes: 2,
      avgTokens: 85,
    },
  ]);
  expect(learnedStats(db, Date.now() + 1000)).toEqual([]);
});
