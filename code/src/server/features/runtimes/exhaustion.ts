import type { Database } from "bun:sqlite";
import {
  markAccountExhausted,
  recordAccountReactiveExhaustion,
  resetAccountExhaustion,
} from "../agents/api";
import { accountQuota, recordQuota } from "../usage/api";
import type { RunContext, RunOutcome } from "./adapter";
import { type Cooldown, endState, killCooldown, QUOTA_COOLDOWN } from "./outcome";
import type { RunState } from "./runs-repo";
import type { Live } from "./shutdown";

// Runs started before account routing have no account_id; they belong to their runtime's default.
function accountOf(db: Database, runId: string): string | null {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT COALESCE(account_id, 'default:' || agent_id) AS id FROM runs WHERE id = ?",
    )
    .get(runId);
  return row?.id ?? null;
}

// A reading from a live run is the account's own: store it under that account. A full window blocks
// the account until it resets, or for the quota fallback when the reading gives no reset time.
// Returns whether the account still has a full window, which is what makes a later error a quota error.
export function recordRunQuota(
  db: Database,
  runId: string,
  q: Parameters<RunContext["onQuota"]>[0],
): boolean {
  const accountId = accountOf(db, runId);
  // No run row means nothing to attribute the reading to; storing it under a guessed account would
  // feed another account's window.
  if (accountId === null) return false;
  recordQuota(db, { ...q, accountId, source: "acp" });
  const until = q.resetsAt ?? Date.now() + QUOTA_COOLDOWN.fallbackMs;
  if (q.usedPercent >= 100 && until > Date.now()) markAccountExhausted(db, accountId, until);
  return accountQuota(db, accountId).some((v) => v.usedPercent !== null && v.usedPercent >= 100);
}

function markRunCooldown(db: Database, runId: string, cooldown: Cooldown | null): void {
  if (cooldown === null) return;
  const accountId = accountOf(db, runId);
  if (accountId === null) return;
  const now = Date.now();
  const resets = accountQuota(db, accountId)
    .filter((v) => v.usedPercent !== null && v.usedPercent >= 100 && (v.resetsAt ?? 0) > now)
    .map((v) => v.resetsAt ?? 0);
  if (cooldown.kind === "quota") {
    if (resets.length > 0) markAccountExhausted(db, accountId, Math.max(...resets));
    else recordAccountReactiveExhaustion(db, accountId, now);
    return;
  }
  markAccountExhausted(db, accountId, now + cooldown.fallbackMs);
}

// The state a run ends in, plus the account block that ending calls for.
export function endAndMark(
  db: Database,
  runId: string,
  run: Live,
  outcome: RunOutcome,
): [RunState, string | null] {
  const [state, reason, cooldown] = endState(db, runId, run, outcome);
  if (state === "completed") {
    const accountId = accountOf(db, runId);
    if (accountId !== null) resetAccountExhaustion(db, accountId);
  }
  markRunCooldown(db, runId, cooldown);
  return [state, reason];
}

// A kill can land after the lane returned, while the account write-back is pending; it still ends the
// run killed and still blocks the account.
export function endKilled(db: Database, runId: string, reason: string): [RunState, string] {
  markRunCooldown(db, runId, killCooldown(reason));
  return ["killed", reason];
}
