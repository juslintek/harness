import type { Database } from "bun:sqlite";
import { getMember } from "../orgs/api";
import { getProposal, type ProposalChange, type ProposalView } from "../policies/api";
import { hasPolicyWake } from "./repo";
import { recordWake } from "./triggers";

// Opening and every review both announce "open", so a reviewer is woken once and only while they
// have not answered.
function wakeReviewers(db: Database, proposal: ProposalView): boolean {
  const handle = getMember(db, proposal.proposedBy)?.handle ?? "someone";
  const excerpt = `${proposal.id}: @${handle} proposes ${proposal.key} = ${JSON.stringify(proposal.value)} because ${JSON.stringify(proposal.reason)}`;
  let woken = false;
  for (const memberId of proposal.reviewers) {
    if (proposal.reviews.some((r) => r.reviewerId === memberId)) continue;
    if (hasPolicyWake(db, memberId, proposal.id)) continue;
    const detail = { proposal: proposal.id, excerpt: excerpt.slice(0, 500) };
    woken =
      recordWake(db, {
        memberId,
        reason: "policy_review",
        detail,
        causedBy: proposal.proposedBy,
      }) !== null || woken;
  }
  return woken;
}

// True when a wake was recorded, so the caller knows to start the executor.
export function onPolicyChange(db: Database, change: ProposalChange): boolean {
  const proposal = getProposal(db, change.proposalId);
  if (!proposal) return false;
  if (change.status === "open") return wakeReviewers(db, proposal);
  if (change.status === "withdrawn") return false;
  const detail = {
    kind: "policy",
    outcome: change.status,
    reason: proposal.decisionReason ?? "",
    proposal: proposal.id,
  };
  const wake = { memberId: proposal.proposedBy, reason: "approval_resolved" as const, detail };
  return recordWake(db, { ...wake, causedBy: proposal.decidedBy }) !== null;
}
