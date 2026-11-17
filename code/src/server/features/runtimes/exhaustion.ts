import type { Database } from "bun:sqlite";
import { markAccountExhausted } from "../agents/api";
import { accountQuota, recordQuota } from "../usage/api";
import type { RunContext } from "./adapter";
import type { Cooldown } from "./outcome";
import type { RunState } from "./runs-repo";

// Runs started before account routing have no account_id; they belong to their runtime's default.
function accountOf(db: Database, runId: string): string | null {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT COALESCE(account_id, 'default:' || agent_id) AS id FROM runs WHERE id = ?",
    )
    .get(runId);
  return row?.id ?? null;
}

// A reading from a live run is the account's own: store it under that account, and a full window
// blocks the account until the window resets.
export function recordRunQuota(
  db: Database,
  runId: string,
  q: Parameters<RunContext["onQuota"]>[0],
): void {
  const accountId = accountOf(db, runId);
  // No run row means nothing to attribute the reading to; storing it under a guessed account would
  // feed another account's window.
  if (accountId === null) return;
  recordQuota(db, { ...q, accountId, source: "acp" });
  if (q.usedPercent >= 100 && q.resetsAt !== null && q.resetsAt > Date.now()) {
    markAccountExhausted(db, accountId, q.resetsAt);
  }
}

// Takes the run's ending and hands back its state and reason, so the caller cannot drop the cooldown.
export function markRunCooldown(
  db: Database,
  runId: string,
  [state, reason, cooldown]: [RunState, string | null, Cooldown | null],
): [RunState, string | null] {
  const accountId = cooldown === null ? null : accountOf(db, runId);
  if (cooldown === null || accountId === null) return [state, reason];
  const now = Date.now();
  const resets = accountQuota(db, accountId)
    .filter((v) => v.usedPercent !== null && v.usedPercent >= 100 && (v.resetsAt ?? 0) > now)
    .map((v) => v.resetsAt ?? 0);
  const until =
    cooldown.kind === "quota" && resets.length > 0
      ? Math.max(...resets)
      : now + cooldown.fallbackMs;
  markAccountExhausted(db, accountId, until);
  return [state, reason];
}
