import type { OrgDetail } from "@shared/orgs";
import { type PolicyProposal, proposalListSchema } from "@shared/policies";
import { createSignal, For, type JSX, Show } from "solid-js";
import { api } from "../../api";
import { ignored } from "../../auth/me";
import { createLoad } from "../../load";
import { createAction } from "../../ui/action";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Button, Field, Panel, StatusBadge, type Tone } from "../../ui/primitives";
import { fmtTime } from "../auth/time";
import { FormError } from "../orgs/shared";
import { handleOf, show } from "./policies-data";

type Filter = "open" | "all";

const STATUS_TONE: Record<PolicyProposal["status"], Tone> = {
  open: "warning",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
};

function Decide(props: {
  proposal: PolicyProposal;
  slug: string;
  onDone: () => void;
}): JSX.Element {
  const [reason, setReason] = createSignal("");
  const [rejecting, setRejecting] = createSignal(false);
  const action = createAction();
  const decide = (decision: "approve" | "reject"): Promise<void> =>
    action.run(async () => {
      const path = `/api/orgs/${props.slug}/policy-proposals/${props.proposal.id}/decide`;
      await api(path, ignored, { method: "POST", body: { decision, reason: reason() } });
      props.onDone();
    });
  return (
    <div class="form-row">
      <Field label={`Reason for ${props.proposal.key} decision (optional)`} error={action.error()}>
        {(c) => (
          <input {...c()} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
        )}
      </Field>
      <Button
        tone="primary"
        aria-label={`Approve ${props.proposal.key} proposal`}
        disabled={action.busy()}
        onClick={() => void decide("approve")}
      >
        Approve
      </Button>
      <Button
        tone="danger"
        aria-label={`Reject ${props.proposal.key} proposal`}
        disabled={action.busy()}
        onClick={() => setRejecting(true)}
      >
        Reject
      </Button>
      <ConfirmDialog
        open={rejecting()}
        title={`Reject the ${props.proposal.key} proposal?`}
        message="The proposed value is not applied. The proposer sees your reason."
        confirm="Reject proposal"
        onClose={() => setRejecting(false)}
        onConfirm={() => {
          setRejecting(false);
          void decide("reject");
        }}
      />
    </div>
  );
}

function ProposalCard(props: {
  proposal: PolicyProposal;
  detail: OrgDetail;
  onDone: () => void;
}): JSX.Element {
  const who = (id: string): string => handleOf(id, props.detail.members);
  return (
    <li class="policy-card">
      <p class="proposal-line">
        <strong>{who(props.proposal.proposedBy)}</strong> proposes <code>{props.proposal.key}</code>{" "}
        = <strong>{show(props.proposal.value)}</strong> for {who(props.proposal.targetId)}
        <StatusBadge tone={STATUS_TONE[props.proposal.status]} value={props.proposal.status} />
      </p>
      <p class="muted-line">
        {fmtTime(props.proposal.createdAt)}: {props.proposal.reason || "no reason given"}
      </p>
      <Show when={props.proposal.reviews.length > 0}>
        <ul class="review-list">
          <For each={props.proposal.reviews}>
            {(r) => (
              <li>
                {who(r.reviewerId)} reviewed: {r.verdict}
                {r.comment ? `, "${r.comment}"` : ""}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.proposal.decisionReason}>
        {(text) => <p class="muted-line">Decision: {text()}</p>}
      </Show>
      <Show when={props.proposal.status === "open"}>
        <Decide proposal={props.proposal} slug={props.detail.org.slug} onDone={props.onDone} />
      </Show>
    </li>
  );
}

export function Proposals(props: { detail: OrgDetail }): JSX.Element {
  const [filter, setFilter] = createSignal<Filter>("open");
  const list = createLoad(
    () =>
      `/api/orgs/${props.detail.org.slug}/policy-proposals${filter() === "open" ? "?status=open" : ""}`,
    proposalListSchema,
  );
  return (
    <Panel title="Policy proposals">
      <div class="stack">
        <div class="form-row">
          <Field label="Show">
            {(c) => (
              <select {...c()} onChange={(e) => setFilter(e.currentTarget.value as Filter)}>
                <option value="open" selected={filter() === "open"}>
                  Open
                </option>
                <option value="all" selected={filter() === "all"}>
                  All
                </option>
              </select>
            )}
          </Field>
        </div>
        <FormError message={list.error()} />
        <Show when={list.data()?.length === 0}>
          <p class="muted-line">No proposals.</p>
        </Show>
        <ul class="card-list">
          <For each={list.data()}>
            {(p) => (
              <ProposalCard proposal={p} detail={props.detail} onDone={() => void list.reload()} />
            )}
          </For>
        </ul>
      </div>
    </Panel>
  );
}
