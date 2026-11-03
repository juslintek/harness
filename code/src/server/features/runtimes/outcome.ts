import type { Database } from "bun:sqlite";
import type { RunOutcome } from "./adapter";
import { hasExpiredApproval, type RunState } from "./runs-repo";
import type { Live } from "./shutdown";

export function endState(
  db: Database,
  runId: string,
  run: Live,
  o: RunOutcome,
): [RunState, string | null] {
  if (run.killReason !== null) return ["killed", run.killReason];
  if (hasExpiredApproval(db, runId)) return ["blocked", "approval_timeout"];
  switch (o.stopReason) {
    case "end_turn":
      return ["completed", null];
    case "cancelled":
      return run.denied ? ["blocked", "guard_denied"] : ["cancelled", null];
    case "refusal":
    case "max_tokens":
      return ["failed", o.stopReason];
    default:
      return ["failed", o.error ?? o.stopReason];
  }
}
