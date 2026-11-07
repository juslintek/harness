import type { Database } from "bun:sqlite";
import type { ApprovalView } from "../../../shared/runs";
import { getRun } from "../runtimes/api";
import { hasApprovalWake } from "./repo";
import { recordWake } from "./triggers";

const COMMAND_CHARS = 200;
const ENDED = new Set(["completed", "failed", "blocked", "cancelled", "killed"]);

// A run that is still waiting picks the answer up by itself, so only an ended run needs a new one.
// Guard announces pending and then resolved, so the stored approval id keeps a repeat from waking
// twice, and the agent id in "agent:<id>" keeps a manager from waking itself.
export function onApprovalResolved(db: Database, approval: ApprovalView): boolean {
  if (approval.status === "pending") return false;
  const run = getRun(db, approval.runId);
  if (!run?.memberId || !ENDED.has(run.state)) return false;
  if (hasApprovalWake(db, run.memberId, approval.id)) return false;
  const detail = {
    kind: "command",
    outcome: approval.status,
    reason: approval.command.slice(0, COMMAND_CHARS),
    approval: approval.id,
  };
  const decider = approval.decidedBy?.startsWith("agent:") ? approval.decidedBy.slice(6) : null;
  return (
    recordWake(db, {
      memberId: run.memberId,
      reason: "approval_resolved",
      taskId: run.taskId ?? undefined,
      detail,
      causedBy: decider,
    }) !== null
  );
}
