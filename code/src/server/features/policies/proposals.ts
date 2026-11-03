import type { Database } from "bun:sqlite";
import { type PolicyKey, policyKeys } from "../../../shared/policies";
import { getMember, managerPositionsOf, reportsTransitivelyTo } from "../orgs/api";
import { contextForMember } from "./repo";
import { effective, setPolicy } from "./resolve";

type Status = "open" | "approved" | "rejected" | "withdrawn";

export interface ProposalView {
  id: string;
  orgId: string;
  layer: "agent";
  targetId: string;
  key: PolicyKey;
  value: unknown;
  reason: string;
  proposedBy: string;
  status: Status;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: number;
  decidedAt: number | null;
  reviewers: string[];
  reviews: { reviewerId: string; verdict: "approve" | "reject"; comment: string | null }[];
}

export type Decider = { kind: "human"; userId: string } | { kind: "agent"; memberId: string };

export interface ProposalChange {
  proposalId: string;
  orgId: string;
  status: Status;
}

const listeners = new Set<(change: ProposalChange) => void>();

export function onProposalChange(fn: (change: ProposalChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(change: ProposalChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch (err) {
      console.error("policy proposal listener failed", err);
    }
  }
}

type Raw = {
  id: string;
  org_id: string;
  target_id: string;
  key: PolicyKey;
  value: string;
  reason: string;
  proposed_by: string;
  status: Status;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: number;
  decided_at: number | null;
};

function view(db: Database, r: Raw): ProposalView {
  const reviewers = db
    .query<{ reviewer_id: string }, [string]>(
      "SELECT reviewer_id FROM policy_review_requests WHERE proposal_id = ? ORDER BY reviewer_id",
    )
    .all(r.id)
    .map((x) => x.reviewer_id);
  const reviews = db
    .query<
      { reviewer_id: string; verdict: "approve" | "reject"; comment: string | null },
      [string]
    >(
      "SELECT reviewer_id, verdict, comment FROM policy_reviews WHERE proposal_id = ? ORDER BY created_at, reviewer_id",
    )
    .all(r.id)
    .map((x) => ({ reviewerId: x.reviewer_id, verdict: x.verdict, comment: x.comment }));
  return {
    id: r.id,
    orgId: r.org_id,
    layer: "agent",
    targetId: r.target_id,
    key: r.key,
    value: JSON.parse(r.value),
    reason: r.reason,
    proposedBy: r.proposed_by,
    status: r.status,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    reviewers,
    reviews,
  };
}

const getRaw = (db: Database, id: string): Raw | null =>
  db.query<Raw, [string]>("SELECT * FROM policy_proposals WHERE id = ?").get(id);

// A reviewer other than the proposer from the proposer's own org; anything else throws.
function assertReviewer(db: Database, orgId: string, proposer: string, reviewerId: string): void {
  if (reviewerId === proposer) throw new Error("a proposer cannot review their own proposal");
  if (getMember(db, reviewerId)?.orgId !== orgId) throw new Error("reviewer not in org");
}

export function propose(
  db: Database,
  input: {
    orgId: string;
    memberId: string;
    key: PolicyKey;
    value: unknown;
    reason: string;
    reviewers: string[];
  },
): ProposalView {
  const proposer = getMember(db, input.memberId);
  if (proposer?.orgId !== input.orgId) throw new Error("member not in org");
  const parsed = policyKeys[input.key].schema.safeParse(input.value);
  if (!parsed.success) throw new Error("invalid value");
  for (const reviewerId of input.reviewers) {
    assertReviewer(db, input.orgId, input.memberId, reviewerId);
  }
  const id = Bun.randomUUIDv7();
  db.transaction(() => {
    db.query(
      `INSERT INTO policy_proposals (id, org_id, layer, target_id, key, value, reason, proposed_by, status, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      id,
      input.orgId,
      input.memberId,
      input.key,
      JSON.stringify(parsed.data),
      input.reason,
      input.memberId,
      Date.now(),
    );
    for (const reviewerId of new Set(input.reviewers)) {
      db.query("INSERT INTO policy_review_requests (proposal_id, reviewer_id) VALUES (?, ?)").run(
        id,
        reviewerId,
      );
    }
  })();
  emit({ proposalId: id, orgId: input.orgId, status: "open" });
  return view(db, getRaw(db, id) as Raw);
}

export function review(
  db: Database,
  input: {
    proposalId: string;
    reviewerId: string;
    verdict: "approve" | "reject";
    comment: string;
  },
): void {
  const proposal = getRaw(db, input.proposalId);
  if (!proposal) throw new Error("proposal not found");
  if (proposal.status !== "open") throw new Error("already decided");
  assertReviewer(db, proposal.org_id, proposal.proposed_by, input.reviewerId);
  const invited = db
    .query("SELECT 1 FROM policy_review_requests WHERE proposal_id = ? AND reviewer_id = ?")
    .get(input.proposalId, input.reviewerId);
  if (!invited) throw new Error("not invited to review this proposal");
  db.query(
    `INSERT INTO policy_reviews (proposal_id, reviewer_id, verdict, comment, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (proposal_id, reviewer_id)
     DO UPDATE SET verdict = excluded.verdict, comment = excluded.comment, created_at = excluded.created_at`,
  ).run(input.proposalId, input.reviewerId, input.verdict, input.comment, Date.now());
  emit({ proposalId: proposal.id, orgId: proposal.org_id, status: "open" });
}

type Decision = { ok: true } | { ok: false; reason: string };

// An agent may decide only as a manager the proposer reports to, and never loosen a tighten-only key.
function agentMayDecide(
  db: Database,
  proposal: Raw,
  memberId: string,
  decision: "approve" | "reject",
): Decision {
  const decider = getMember(db, memberId);
  if (decider?.orgId !== proposal.org_id) return { ok: false, reason: "decider not in org" };
  const manages = managerPositionsOf(db, memberId).some((position) =>
    reportsTransitivelyTo(db, proposal.proposed_by, position.id),
  );
  if (!manages) return { ok: false, reason: "decider is not a manager of the proposer" };
  const order = policyKeys[proposal.key].tightenOnly as readonly unknown[] | undefined;
  if (order && decision === "approve") {
    const current = effective(db, contextForMember(db, proposal.proposed_by), proposal.key).value;
    if (order.indexOf(JSON.parse(proposal.value)) < order.indexOf(current)) {
      return { ok: false, reason: "an agent cannot approve loosening this key" };
    }
  }
  return { ok: true };
}

class Rollback extends Error {}

export function decideProposal(
  db: Database,
  input: {
    proposalId: string;
    decidedBy: Decider;
    decision: "approve" | "reject";
    reason: string;
  },
): Decision {
  const proposal = getRaw(db, input.proposalId);
  if (!proposal) return { ok: false, reason: "proposal not found" };
  if (proposal.status !== "open") return { ok: false, reason: "already decided" };
  const { decidedBy } = input;
  if (decidedBy.kind === "agent") {
    const allowed = agentMayDecide(db, proposal, decidedBy.memberId, input.decision);
    if (!allowed.ok) return allowed;
  }
  const status: Status = input.decision === "approve" ? "approved" : "rejected";
  const by = decidedBy.kind === "human" ? decidedBy.userId : decidedBy.memberId;
  try {
    db.transaction(() => {
      const claimed = db
        .query(
          `UPDATE policy_proposals SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(status, by, input.reason, Date.now(), proposal.id);
      if (claimed.changes === 0) throw new Rollback("already decided");
      if (status !== "approved") return;
      const applied = setPolicy(db, {
        layer: "agent",
        targetId: proposal.target_id,
        key: proposal.key,
        value: JSON.parse(proposal.value),
        setBy: `proposal:${proposal.id}`,
      });
      if (!applied.ok) throw new Rollback(applied.reason);
    })();
  } catch (err) {
    if (err instanceof Rollback) return { ok: false, reason: err.message };
    throw err;
  }
  emit({ proposalId: proposal.id, orgId: proposal.org_id, status });
  return { ok: true };
}

export function getProposal(db: Database, id: string): ProposalView | null {
  const raw = getRaw(db, id);
  return raw ? view(db, raw) : null;
}

export function listProposals(db: Database, orgId: string, status?: Status): ProposalView[] {
  const rows = status
    ? db
        .query<Raw, [string, string]>(
          "SELECT * FROM policy_proposals WHERE org_id = ? AND status = ? ORDER BY created_at DESC, id DESC",
        )
        .all(orgId, status)
    : db
        .query<Raw, [string]>(
          "SELECT * FROM policy_proposals WHERE org_id = ? ORDER BY created_at DESC, id DESC",
        )
        .all(orgId);
  return rows.map((r) => view(db, r));
}
