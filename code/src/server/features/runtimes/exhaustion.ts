import type { Database } from "bun:sqlite";
import { markAccountExhausted } from "../agents/api";
import { accountQuota, recordQuota } from "../usage/api";
import type { RunContext } from "./adapter";
import type { Cooldown } from "./outcome";

// Runs started before account routing have no account_id; they belong to their runtime's default.
function accountOf(db: Database, runId: string): string {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT COALESCE(account_id, 'default:' || agent_id) AS id FROM runs WHERE id = ?",
    )
    .get(runId);
  return row?.id ?? "";
}

// A reading from a live run is the account's own: store it under that account, and a full window
// blocks the account until the window resets.
export function recordRunQuota(
  db: Database,
  runId: string,
  q: Parameters<RunContext["onQuota"]>[0],
): void {
  const accountId = accountOf(db, runId);
  recordQuota(db, { ...q, accountId, source: "acp" });
  if (q.usedPercent >= 100 && q.resetsAt !== null && q.resetsAt > Date.now()) {
    markAccountExhausted(db, accountId, q.resetsAt);
  }
}

export function markRunCooldown(db: Database, runId: string, cooldown: Cooldown | null): void {
  if (cooldown === null) return;
  const accountId = accountOf(db, runId);
  const now = Date.now();
  const resets = accountQuota(db, accountId)
    .filter((v) => v.usedPercent !== null && v.usedPercent >= 100 && (v.resetsAt ?? 0) > now)
    .map((v) => v.resetsAt ?? 0);
  const until =
    cooldown.kind === "quota" && resets.length > 0
      ? Math.max(...resets)
      : now + cooldown.fallbackMs;
  markAccountExhausted(db, accountId, until);
}
