import type { Database } from "bun:sqlite";
import type { RunOutcome } from "./adapter";
import { hasExpiredApproval, type RunState } from "./runs-repo";
import type { Live } from "./shutdown";

const QUOTA_TEXT = /rate.?limit|\b429\b|quota|usage limit/i;
const OVERLOADED_TEXT = /overloaded/i;

// How long the account should be skipped. Both endings stay `rate_limited` for failover; only the
// account's block differs: a quota block runs to the window reset (the caller knows it), an overload
// is a short pause.
export interface Cooldown {
  kind: "quota" | "overloaded";
  fallbackMs: number;
}
export const QUOTA_COOLDOWN: Cooldown = { kind: "quota", fallbackMs: 15 * 60_000 };
const OVERLOADED_COOLDOWN: Cooldown = { kind: "overloaded", fallbackMs: 2 * 60_000 };

// A run stopped by the quota watchdog blocks its account like a quota error does.
export const killCooldown = (reason: string): Cooldown | null =>
  reason === "quota_exhausted" ? QUOTA_COOLDOWN : null;

export function endState(
  db: Database,
  runId: string,
  run: Live,
  o: RunOutcome,
): [RunState, string | null, Cooldown | null] {
  if (run.killReason !== null) {
    return ["killed", run.killReason, killCooldown(run.killReason)];
  }
  if (hasExpiredApproval(db, runId)) return ["blocked", "approval_timeout", null];
  switch (o.stopReason) {
    case "end_turn":
      return ["completed", null, null];
    case "cancelled":
      return run.denied ? ["blocked", "guard_denied", null] : ["cancelled", null, null];
    case "refusal":
    case "max_tokens":
      return ["failed", o.stopReason, null];
    default:
      if (run.quotaFull === true || QUOTA_TEXT.test(o.error ?? "")) {
        return ["failed", "rate_limited", QUOTA_COOLDOWN];
      }
      if (OVERLOADED_TEXT.test(o.error ?? ""))
        return ["failed", "rate_limited", OVERLOADED_COOLDOWN];
      return ["failed", o.error ?? o.stopReason, null];
  }
}
