import type { Database } from "bun:sqlite";
import { postSystemMessage } from "../chat/api";
import { appendEvent } from "../logs/api";
import { killRun } from "../runtimes/api";
import { onUsageRecorded } from "../usage/api";
import {
  type BudgetLevel,
  type BudgetRow,
  budgetsCovering,
  memberIdsOf,
  recordAlert,
  scopeLabel,
} from "./repo";
import { periodKey, viewOf } from "./spend";

function announce(db: Database, b: BudgetRow, level: BudgetLevel, ratio: number): void {
  const text = `Budget ${scopeLabel(db, b)} at ${Math.floor(ratio * 100)}% of ${b.monthlyUsd} USD`;
  appendEvent(db, {
    kind: "process",
    operation: `budget_${level}`,
    source: "budgets",
    body: text,
    dedupeKey: `budget:${b.id}:${periodKey(Date.now())}:${level}`,
  });
  postSystemMessage(db, b.orgId, text);
}

function killLiveRuns(db: Database, b: BudgetRow): void {
  for (const memberId of memberIdsOf(db, { kind: b.scopeKind, id: b.scopeId })) {
    const live = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM runs WHERE member_id = ? AND ended_at IS NULL",
      )
      .all(memberId);
    for (const { id } of live) killRun(db, id, "budget_exhausted");
  }
}

function evaluate(db: Database, runId: string | null): void {
  const memberId =
    runId === null
      ? null
      : (db
          .query<{ member_id: string | null }, [string]>("SELECT member_id FROM runs WHERE id = ?")
          .get(runId)?.member_id ?? null);
  if (memberId === null) return;
  const now = Date.now();
  const period = periodKey(now);
  for (const b of budgetsCovering(db, memberId)) {
    const view = viewOf(db, b, now);
    // A crossing straight to 100% records the warn level too, so one message says it.
    const warned = view.state !== "ok" && recordAlert(db, b.id, period, "warn");
    const paused = view.state === "paused" && recordAlert(db, b.id, period, "pause");
    if (paused) announce(db, b, "pause", view.ratio);
    else if (warned) announce(db, b, "warn", view.ratio);
    if (view.state === "paused") killLiveRuns(db, b);
  }
}

export function startBudgets(db: Database): () => void {
  return onUsageRecorded((runId) => evaluate(db, runId));
}
