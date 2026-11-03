import { useState } from "preact/hooks";
import type { OrgDetail } from "../../../shared/orgs";
import { type PolicyProposal, proposalListSchema } from "../../../shared/policies";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { handleOf, show } from "./policies-data";

type Filter = "open" | "all";

function Decide({
  proposal,
  slug,
  onDone,
}: {
  proposal: PolicyProposal;
  slug: string;
  onDone: () => void;
}): preact.JSX.Element {
  const [reason, setReason] = useState("");
  const action = useAction();
  const decide = (decision: "approve" | "reject"): void => {
    action
      .run(async () => {
        const path = `/api/orgs/${slug}/policy-proposals/${proposal.id}/decide`;
        await api(path, ignored, { method: "POST", body: { decision, reason } });
        onDone();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <div class="row">
      <label>
        Reason for {proposal.key} decision (optional)
        <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
      </label>
      <button
        type="button"
        aria-label={`Approve ${proposal.key} proposal`}
        disabled={action.busy}
        onClick={() => decide("approve")}
      >
        Approve
      </button>
      <button
        type="button"
        class="danger"
        aria-label={`Reject ${proposal.key} proposal`}
        disabled={action.busy}
        onClick={() => decide("reject")}
      >
        Reject
      </button>
      <ErrorLine message={action.error} />
    </div>
  );
}

function ProposalCard({
  proposal,
  detail,
  onDone,
}: {
  proposal: PolicyProposal;
  detail: OrgDetail;
  onDone: () => void;
}): preact.JSX.Element {
  const who = (id: string): string => handleOf(id, detail.members);
  return (
    <li class="card">
      <p>
        <strong>{who(proposal.proposedBy)}</strong> proposes <code>{proposal.key}</code> ={" "}
        <strong>{show(proposal.value)}</strong> for {who(proposal.targetId)}
        <span class="badge">{proposal.status}</span>
      </p>
      <p class="muted">
        {fmtTime(proposal.createdAt)}: {proposal.reason || "no reason given"}
      </p>
      {proposal.reviews.length > 0 && (
        <ul class="plain">
          {proposal.reviews.map((r) => (
            <li key={r.reviewerId}>
              {who(r.reviewerId)} reviewed: {r.verdict}
              {r.comment ? `, "${r.comment}"` : ""}
            </li>
          ))}
        </ul>
      )}
      {proposal.decisionReason && <p class="muted">Decision: {proposal.decisionReason}</p>}
      {proposal.status === "open" && (
        <Decide proposal={proposal} slug={detail.org.slug} onDone={onDone} />
      )}
    </li>
  );
}

export function Proposals({ detail }: { detail: OrgDetail }): preact.JSX.Element {
  const [filter, setFilter] = useState<Filter>("open");
  const status = filter === "open" ? "?status=open" : "";
  const list = useLoad(
    () => api(`/api/orgs/${detail.org.slug}/policy-proposals${status}`, proposalListSchema),
    [detail.org.slug, filter],
  );
  return (
    <section>
      <h3>Policy proposals</h3>
      <label class="inline">
        Show
        <select value={filter} onChange={(e) => setFilter(e.currentTarget.value as Filter)}>
          <option value="open">Open</option>
          <option value="all">All</option>
        </select>
      </label>
      <ErrorLine message={list.error} />
      {list.data?.length === 0 && <p class="muted">No proposals.</p>}
      <ul class="plain">
        {list.data?.map((p) => (
          <ProposalCard key={p.id} proposal={p} detail={detail} onDone={list.reload} />
        ))}
      </ul>
    </section>
  );
}
